/**
 * LiveMessage — the single output surface for one turn.
 *
 * One Telegram message per turn, edited in place as the answer streams. Two
 * edit-in-place messages in one DM would exceed Telegram's ~1 msg/s per-chat
 * budget on their own, so activity rows and answer text share one body.
 *
 * The contract with callers is push-only: they set state whenever they like and
 * this class decides when to spend an API call. Frames arriving inside the
 * throttle window are coalesced latest-wins and the intermediate ones are
 * *dropped*, never queued — a queue would mean the message lags further behind
 * the model the longer the turn runs, which is the opposite of live.
 *
 * Rendering invariant: every string sent with parse_mode HTML is structurally
 * closed. Streaming necessarily sends prefixes of an unfinished document, and
 * an unbalanced tag is a hard 400 from Telegram, so `closeOpenTags` runs on
 * every frame — including the ones we build ourselves.
 */

import { isBadEntities, isNotModified, TgError } from "../errors.ts";
import { errFields, type Logger } from "../log.ts";
import type { TelegramApi } from "./api.ts";
import type { TgMessage } from "./types.ts";
import { closeOpenTags, esc, stripTags } from "./html.ts";
import { compileBlocks } from "./markdown.ts";
import { redactOutbound } from "./redact.ts";
import { packBlocks, packTail } from "./chunk.ts";

export interface LiveMessageOptions {
	chatId: number;
	replyTo?: number;
	editThrottleMs: number;
	maxChars: number;
	maxEditsPerTurn: number;
	/**
	 * Turns longer than this deliver their answer as a NEW message instead of a
	 * final edit. Telegram pushes a notification for new messages but not for
	 * edits, so a long turn otherwise finishes in silence and the operator has
	 * to keep checking. Short turns stay as edits — an extra message for a
	 * fifteen-second answer is noise, not a signal.
	 */
	notifyAfterMs: number;
	/**
	 * Adopt a placeholder that was already posted (queued turns announce
	 * themselves the moment they are accepted, before they start running).
	 */
	existingMessageId?: number;
}

function fmtElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} 秒`;
	return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export class LiveMessage {
	private readonly api: TelegramApi;
	private readonly log: Logger;
	private readonly opts: LiveMessageOptions;

	private messageId: number | null = null;
	private adopted = false;
	private activity = "";
	private answer = "";
	private lastSentBody: string | null = null;
	private lastEditAt = 0;
	private editCount = 0;
	private timer: NodeJS.Timeout | null = null;
	private inFlight = false;
	private pending = false;
	private suppressedUntil = 0;
	private closed = false;
	private redactionNoted = false;
	private readonly createdAt = Date.now();

	constructor(api: TelegramApi, log: Logger, opts: LiveMessageOptions) {
		this.api = api;
		this.log = log;
		this.opts = opts;
	}

	async begin(placeholder = "⏳ …"): Promise<void> {
		if (this.opts.existingMessageId !== undefined && !this.adopted) {
			// Reuse the queued-notice message instead of posting a second one.
			this.adopted = true;
			this.messageId = this.opts.existingMessageId;
			this.lastSentBody = null;
			this.lastEditAt = 0;
			await this.edit(esc(placeholder)).catch(() => undefined);
			return;
		}
		if (this.messageId !== null) return;
		const text = esc(placeholder);
		const params: Parameters<TelegramApi["sendMessage"]>[0] = {
			chat_id: this.opts.chatId,
			text,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		};
		if (this.opts.replyTo !== undefined) params.reply_to_message_id = this.opts.replyTo;
		try {
			const msg: TgMessage = await this.api.sendMessage(params);
			this.messageId = msg.message_id;
			this.lastSentBody = text;
			this.lastEditAt = Date.now();
		} catch (err) {
			this.log.error({ msg: "live.begin failed", ...errFields(err) });
			throw err;
		}
	}

	setActivity(text: string): void {
		if (this.closed) return;
		this.activity = text;
		this.schedule();
	}

	/** `text` is the cumulative answer in the model's markdown, never a delta. */
	setAnswer(text: string): void {
		if (this.closed) return;
		// Redact on the way to the chat, not on the way to the model: the model
		// needs the credentials it was given, the transcript on a phone does not.
		const { text: safe, count } = redactOutbound(text);
		if (count > 0 && !this.redactionNoted) {
			this.redactionNoted = true;
			this.log.info({ msg: "redacted secrets from outbound message", rules: count });
		}
		this.answer = safe;
		this.schedule();
	}

	/** Compile current state into one closed HTML body within the size budget. */
	private compose(): string {
		const blocks: string[] = [];
		if (this.activity) blocks.push(`<i>${esc(this.activity)}</i>`);
		if (this.answer) blocks.push(...compileBlocks(this.answer));
		if (blocks.length === 0) return esc("⏳ …");
		return closeOpenTags(packTail(blocks, this.opts.maxChars));
	}

	private schedule(): void {
		if (this.timer !== null || this.closed) return;
		const now = Date.now();
		const earliest = Math.max(this.lastEditAt + this.opts.editThrottleMs, this.suppressedUntil);
		const delay = Math.max(0, earliest - now);
		// Not unref'd: a pending render is real work, and dropping it because the
		// event loop happened to be empty would lose the final frame of a turn.
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, delay);
	}

	/** Edit with HTML, and on a parse rejection retry once as plain text. */
	private async edit(body: string): Promise<void> {
		if (this.messageId === null) return;
		try {
			await this.api.editMessageText({
				chat_id: this.opts.chatId,
				message_id: this.messageId,
				text: body,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
			this.lastSentBody = body;
		} catch (err) {
			if (isNotModified(err)) {
				this.lastSentBody = body;
				return;
			}
			if (isBadEntities(err)) {
				// The compiler produced something Telegram rejected. Log enough to
				// reproduce it, then deliver the content anyway — losing an answer
				// to a rendering bug is the worst possible outcome.
				this.log.error({ msg: "HTML rejected, falling back to plain text", sample: body.slice(0, 400) });
				const plain = stripTags(body).slice(0, this.opts.maxChars);
				await this.api
					.editMessageText({ chat_id: this.opts.chatId, message_id: this.messageId, text: plain })
					.then(() => {
						this.lastSentBody = plain;
					})
					.catch((e: unknown) => this.log.warn({ msg: "plain-text fallback also failed", ...errFields(e) }));
				return;
			}
			throw err;
		}
	}

	private async flush(): Promise<void> {
		if (this.messageId === null) return;
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		if (this.editCount >= this.opts.maxEditsPerTurn) return;
		if (Date.now() < this.suppressedUntil) return;

		const body = this.compose();
		if (body === this.lastSentBody) return; // Telegram 400s on unmodified edits

		this.inFlight = true;
		try {
			await this.edit(body);
			this.lastEditAt = Date.now();
			this.editCount++;
		} catch (err) {
			if (err instanceof TgError && err.kind === "throttled") {
				const wait = (err.retryAfter ?? 5) * 1000;
				this.suppressedUntil = Date.now() + wait;
				this.log.warn({ msg: "throttled, suppressing edits", waitMs: wait });
			} else {
				this.log.warn({ msg: "edit failed", ...errFields(err) });
			}
		} finally {
			this.inFlight = false;
			if (this.pending) {
				this.pending = false;
				this.schedule();
			}
		}
	}

	/**
	 * Final render: one unthrottled edit with the head of the answer, then any
	 * overflow as follow-up messages so nothing is dropped.
	 */
	async finish(finalText: string): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const { text: safeFinal } = redactOutbound(finalText);
		this.answer = safeFinal;
		this.activity = "";
		this.closed = true;

		const blocks = compileBlocks(safeFinal.trim());
		const chunks = blocks.length > 0 ? packBlocks(blocks, this.opts.maxChars) : [esc("（无输出）")];

		if (this.messageId === null) {
			await this.begin(safeFinal.slice(0, 200) || "（无输出）");
			return;
		}

		const elapsed = Date.now() - this.createdAt;
		const notify = elapsed >= this.opts.notifyAfterMs;

		if (notify) {
			// Long turn: collapse the live message to a one-line receipt and deliver
			// the answer as new messages, so Telegram actually pushes a notification
			// and its preview carries the answer rather than "done".
			await this.edit(`<i>✅ 完成 · 用时 ${esc(fmtElapsed(elapsed))} · 结果见下</i>`).catch(() => undefined);
			for (const chunk of chunks) {
				try {
					await this.api.sendMessage({
						chat_id: this.opts.chatId,
						text: closeOpenTags(chunk),
						parse_mode: "HTML",
						link_preview_options: { is_disabled: true },
					});
				} catch (err) {
					this.log.warn({ msg: "notification send failed", ...errFields(err) });
					break;
				}
			}
			this.log.info({ msg: "delivered as new message for notification", elapsedMs: elapsed, chunks: chunks.length });
			return;
		}

		const first = chunks[0] ?? esc("（无输出）");
		if (first !== this.lastSentBody) {
			await this.edit(closeOpenTags(first)).catch((err: unknown) => this.log.warn({ msg: "final edit failed", ...errFields(err) }));
		}

		for (const chunk of chunks.slice(1)) {
			try {
				await this.api.sendMessage({
					chat_id: this.opts.chatId,
					text: closeOpenTags(chunk),
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				});
			} catch (err) {
				this.log.warn({ msg: "continuation send failed", ...errFields(err) });
				break;
			}
		}
	}

	/** Called on shutdown so an in-flight turn leaves a readable trace. */
	async sealWith(note: string): Promise<void> {
		if (this.messageId === null || this.closed) return;
		this.closed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const body = closeOpenTags(`${this.compose()}\n\n<i>${esc(note)}</i>`.slice(0, this.opts.maxChars));
		await this.edit(body).catch(() => {
			/* best effort during shutdown */
		});
	}

	get stats(): { edits: number; messageId: number | null } {
		return { edits: this.editCount, messageId: this.messageId };
	}
}
