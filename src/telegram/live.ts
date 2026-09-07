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
import { DeliveryStore, retryThrottled, sendChunk, sleep } from "./delivery.ts";

/**
 * Some providers begin reasoning by echoing the prompt verbatim before adding
 * any real analysis. Hide only that leading echo; subsequent thinking remains
 * fully visible. Conservative by design: it strips only a long prefix with a
 * clear delimiter or exact whole-text match, never a short coincidental phrase.
 */
export function stripLeadingPromptEcho(thinking: string, prompt: string): string {
	const normalizedPrompt = prompt.trim();
	if (normalizedPrompt.length < 12 || !thinking.startsWith(normalizedPrompt)) return thinking;
	const rest = thinking.slice(normalizedPrompt.length);
	if (!rest) return "";
	const delimiter = /^(?:\r?\n){1,3}|^\s*(?:[-—:：]\s+|["”』」]\s*(?:\r?\n|$))/u.exec(rest);
	if (!delimiter) return thinking;
	return rest.slice(delimiter[0].length).replace(/^\s+/, "");
}

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
	/** Persist unsent final chunks before attempting network delivery. */
	deliveryStore?: DeliveryStore;
	/** Injectable retry clock for deterministic tests. */
	wait?: (ms: number) => Promise<void>;
}

export interface DeliveryResult { complete: boolean; delivered: number; total: number }

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
	private thinking = "";
	private prompt = "";
	private answer = "";
	private contentRevision = 0;
	private sentContentRevision = 0;
	private lastSentBody: string | null = null;
	private lastEditAt = 0;
	private editCount = 0;
	private timer: NodeJS.Timeout | null = null;
	private inFlight = false;
	private activeFlush: Promise<void> | null = null;
	private terminal: Promise<DeliveryResult> | null = null;
	private pending = false;
	private suppressedUntil = 0;
	/** Wall time lost to stalled edits since the last successful one. */
	private stalledMs = 0;
	private stalledCount = 0;
	private closed = false;
	private redactionNoted = false;
	private readonly createdAt = Date.now();

	constructor(api: TelegramApi, log: Logger, opts: LiveMessageOptions) {
		this.api = api;
		this.log = log;
		this.opts = opts;
	}

	/** Prompt used only to suppress a provider's initial verbatim reasoning echo. */
	setPrompt(text: string): void {
		if (this.closed) return;
		this.prompt = text.trim();
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
		// Activity can contain the exact bash command or tool arguments. Apply the
		// same outbound scrubber used for model answers before it reaches Telegram.
		this.activity = redactOutbound(text).text;
		this.schedule();
	}

	/** Provider-visible thinking is streamed separately from the final answer. */
	setThinking(text: string): void {
		if (this.closed) return;
		const visible = stripLeadingPromptEcho(text, this.prompt);
		const { text: safe, count } = redactOutbound(visible);
		if (count > 0 && !this.redactionNoted) {
			this.redactionNoted = true;
			this.log.info({ msg: "redacted secrets from outbound thinking", rules: count });
		}
		if (safe === this.thinking) return;
		this.thinking = safe;
		this.contentRevision++;
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
		if (safe === this.answer) return;
		this.answer = safe;
		this.contentRevision++;
		this.schedule();
	}

	/** Compile current state into one closed HTML body within the size budget. */
	private compose(): string {
		const blocks: string[] = [];
		// Composed before the attempt, cleared after it succeeds — so the notice
		// rides along on the first edit that actually lands, telling the operator
		// the freeze was the network rather than a stuck model.
		if (this.stalledCount > 0 && this.stalledMs >= 5000) {
			blocks.push(`<i>⚠️ 网络抖动，刚才 ${Math.round(this.stalledMs / 1000)} 秒未能更新</i>`);
		}
		if (this.activity) blocks.push(`<i>${esc(this.activity)}</i>`);
		if (this.thinking) {
			const thinkingBlocks = compileBlocks(this.thinking);
			blocks.push(`<b>💭 思考过程</b>`);
			blocks.push(...thinkingBlocks.map((block) => `<blockquote expandable>${esc(stripTags(block))}</blockquote>`));
		}
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
				this.log.error({ msg: "HTML rejected, falling back to plain text", bodyChars: body.length });
				const plain = stripTags(body);
				try {
					await this.api.editMessageText({ chat_id: this.opts.chatId, message_id: this.messageId, text: plain });
				} catch (fallbackError) {
					if (!isNotModified(fallbackError)) throw fallbackError;
				}
				this.lastSentBody = body;
				return;
			}
			throw err;
		}
	}

	private flush(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.activeFlush) { this.pending = true; return this.activeFlush; }
		const task = this.flushFrame().catch((err) => this.log.warn({ msg: "live render failed", ...errFields(err) }));
		this.activeFlush = task;
		void task.then(() => { if (this.activeFlush === task) this.activeFlush = null; });
		return task;
	}

	private async flushFrame(): Promise<void> {
		if (this.messageId === null || this.closed) return;
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		const meaningfulContentPending = this.contentRevision > this.sentContentRevision;
		if (this.editCount >= this.opts.maxEditsPerTurn && !meaningfulContentPending) return;
		if (Date.now() < this.suppressedUntil) return;

		const body = this.compose();
		const revision = this.contentRevision;
		if (body === this.lastSentBody) { this.sentContentRevision = revision; return; } // Telegram 400s on unmodified edits

		this.inFlight = true;
		const attemptStartedAt = Date.now();
		try {
			await this.edit(body);
			this.sentContentRevision = revision;
			this.lastEditAt = Date.now();
			this.editCount++;
			// A recovered stall is invisible otherwise: the operator saw a frozen
			// message and has no way to tell a wedged network from a stuck model.
			if (this.stalledCount > 0) {
				this.log.info({ msg: "edit recovered after stall", stalledMs: this.stalledMs, attempts: this.stalledCount });
				this.stalledCount = 0;
				this.stalledMs = 0;
			}
		} catch (err) {
			this.stalledMs += Date.now() - attemptStartedAt;
			this.stalledCount++;
			if (err instanceof TgError && err.kind === "throttled") {
				const wait = (err.retryAfter ?? 5) * 1000;
				this.suppressedUntil = Date.now() + wait;
				this.log.warn({ msg: "throttled, suppressing edits", waitMs: wait });
			} else {
				this.suppressedUntil = Date.now() + 5000;
				this.log.warn({ msg: "edit failed", ...errFields(err) });
			}
			this.pending = true;
		} finally {
			this.inFlight = false;
			if (this.pending || this.contentRevision > this.sentContentRevision) {
				this.pending = false;
				this.schedule();
			}
		}
	}

	/** One terminal writer owns delivery; repeated finish/seal calls share it. */
	finish(finalText: string): Promise<DeliveryResult> {
		if (this.terminal) return this.terminal;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.answer = redactOutbound(finalText).text;
		this.activity = "";
		this.terminal = this.deliverFinal();
		return this.terminal;
	}

	private async deliverFinal(): Promise<DeliveryResult> {
		// A completed old edit must never land after the final edit/receipt.
		await this.activeFlush;
		const chunks = packBlocks(compileBlocks(this.answer.trim()), this.opts.maxChars);
		if (!chunks[0]) chunks[0] = esc("（无输出）");
		const store = this.opts.deliveryStore;
		const record = store?.create(this.opts.chatId, chunks);
		const wait = this.opts.wait ?? sleep;
		const elapsed = Date.now() - this.createdAt;
		const notify = elapsed >= this.opts.notifyAfterMs;
		let delivered = 0;
		let usedExisting = false;
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
			try {
				if (i === 0 && !notify && this.messageId !== null) {
					try { await retryThrottled(() => this.edit(chunk), wait); usedExisting = true; }
					catch { await sendChunk(this.api, this.opts.chatId, chunk, wait); }
				} else {
					try { await sendChunk(this.api, this.opts.chatId, chunk, wait); }
					catch (err) {
						if (i !== 0 || this.messageId === null) throw err;
						await retryThrottled(() => this.edit(chunk), wait);
						usedExisting = true;
					}
				}
				delivered++;
				if (record) store!.advance(record.id, delivered);
			} catch (err) {
				this.log.warn({ msg: "final delivery incomplete", delivered, totalChunks: chunks.length, ...errFields(err) });
				const note = store ? "⚠️ 回答未完整送达，未确认分段已保存。发送 /retry 重发；网络超时可能造成重复分段。"
					: "⚠️ 回答未完整送达，请稍后重试。";
				// Never erase the only delivered first chunk to show a receipt.
				try {
					if (this.messageId !== null && !usedExisting) await retryThrottled(() => this.edit(esc(note)), wait);
					else await sendChunk(this.api, this.opts.chatId, esc(note), wait);
				} catch { /* Durable outbox remains available even if Telegram is offline. */ }
				return { complete: false, delivered, total: chunks.length };
			}
		}
		if (!usedExisting && this.messageId !== null) {
			await retryThrottled(() => this.edit(`<i>✅ 完成 · 用时 ${esc(fmtElapsed(elapsed))} · 结果已另发</i>`), wait)
				.catch((err) => this.log.warn({ msg: "receipt edit failed", ...errFields(err) }));
		}
		return { complete: true, delivered, total: chunks.length };
	}

	/** Shutdown waits for an existing final delivery instead of racing it. */
	async sealWith(note: string): Promise<void> {
		if (this.terminal) { await this.terminal; return; }
		await this.finish([this.answer, note].filter(Boolean).join("\n\n"));
	}

	get stats(): { edits: number; messageId: number | null } {
		return { edits: this.editCount, messageId: this.messageId };
	}
}
