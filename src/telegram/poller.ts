/**
 * The only getUpdates loop in the process.
 *
 * Two properties matter more than anything else here:
 *
 *  1. Polling never blocks on agent work. A 20-minute turn must not stop us
 *     acknowledging updates, or the server starts reporting "getUpdates not
 *     called for too long" and the backlog grows behind us.
 *  2. A 409 is degradation, not death. It means something else is polling this
 *     bot token; outbound sends still work, so we keep the process alive, keep
 *     saying so in the log, and recover the moment the other consumer stops.
 */

import { TgError } from "../errors.ts";
import { errFields, type Logger } from "../log.ts";
import type { TelegramApi } from "./api.ts";
import type { TgUpdate } from "./types.ts";

const ALLOWED_UPDATES = ["message", "callback_query"];
// 10s, not 30s. The Telegram path from this box intermittently wedges: the
// request connects and then never answers, so the only cost that matters is how
// long we sit blind before giving up and reconnecting. A shorter poll caps that
// blind window at ~20s instead of ~40s; six requests a minute instead of two is
// not a meaningful load.
const POLL_SECONDS = 10;

export type PollerState = "starting" | "running" | "degraded" | "stopped";

export interface PollerOptions {
	allowedUserId: number;
	/**
	 * Slash menu registered on every preflight.
	 *
	 * Supplied by the caller rather than hardcoded here: the menu and the router
	 * that implements the commands must live together, or they drift — which is
	 * exactly how this list ended up advertising commands that no longer existed.
	 */
	commands: Array<{ command: string; description: string }>;
	/** Called for each accepted update, in order. Must not throw. */
	onUpdate: (update: TgUpdate) => void;
	/** Terminal failure — the supervisor should exit, not retry. */
	onFatal: (err: TgError) => void;
}

function jitter(baseMs: number, spread: number): number {
	// Deterministic randomness is not needed here; spread just avoids lockstep
	// retries if several processes ever race for the same token.
	return baseMs + Math.floor(Math.random() * spread);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		// Deliberately NOT unref'd. During a backoff this timer is often the only
		// handle left, and an unref'd one lets the event loop drain — the process
		// then exits 0 and `Restart=on-failure` reads that as a clean finish.
		const t = setTimeout(done, ms);
		function done(): void {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export class Poller {
	private readonly api: TelegramApi;
	private readonly log: Logger;
	private readonly opts: PollerOptions;
	private readonly abort = new AbortController();

	private offset: number | undefined;
	private backoffMs = 1000;
	private stateValue: PollerState = "starting";

	constructor(api: TelegramApi, log: Logger, opts: PollerOptions) {
		this.api = api;
		this.log = log;
		this.opts = opts;
	}

	get state(): PollerState {
		return this.stateValue;
	}

	/** Written through a method so TypeScript keeps the field's full union type. */
	private setState(next: PollerState): void {
		this.stateValue = next;
	}

	/**
	 * Verify the token and clear anything that would prevent long polling.
	 * A configured webhook makes getUpdates fail permanently, so we remove it —
	 * loudly, because that stomps whoever configured it.
	 */
	async preflight(): Promise<void> {
		await this.api.getMe(this.abort.signal);
		this.log.info({ msg: "authenticated" });

		const hook = await this.api.getWebhookInfo(this.abort.signal);
		if (hook.url) {
			this.log.warn({ msg: "deleting configured webhook to enable long polling", pending: hook.pending_update_count });
			await this.api.deleteWebhook(this.abort.signal);
		}

		// Clear stale command lists left by a previous bot under the same token:
		// the default scope and the private-chat scope are the ones that actually
		// show in the slash menu. Telegram returns 400 for the admin/member scopes
		// in a 1:1 chat, so they are not attempted.
		await this.api
			.deleteMyCommands({}, this.abort.signal)
			.catch((err: unknown) => this.log.warn({ msg: "deleteMyCommands default failed (non-fatal)", ...errFields(err) }));
		await this.api
			.deleteMyCommands({ scope: { type: "chat", chat_id: this.opts.allowedUserId } }, this.abort.signal)
			.catch((err: unknown) => this.log.warn({ msg: "deleteMyCommands chat scope failed (non-fatal)", ...errFields(err) }));

		await this.api
			.setMyCommands(this.opts.commands, this.abort.signal)
			.then(() => this.log.info({ msg: "slash menu registered", commands: this.opts.commands.map((c) => c.command) }))
			.catch((err: unknown) => this.log.warn({ msg: "setMyCommands failed (non-fatal)", ...errFields(err) }));
	}

	/** Runs until `stop()`. Resolves only on shutdown. */
	async run(): Promise<void> {
		this.setState("running");
		while (!this.abort.signal.aborted) {
			try {
				const params: Record<string, unknown> = {
					limit: 100,
					timeout: POLL_SECONDS,
					// Sent on every call: the setting is sticky server-side and
					// another process could otherwise narrow it behind our back.
					allowed_updates: ALLOWED_UPDATES,
				};
				if (this.offset !== undefined) params.offset = this.offset;

				const pollStartedAt = Date.now();
				const updates = await this.api.getUpdates(params, this.abort.signal);
				const pollMs = Date.now() - pollStartedAt;
				// The server should return by `timeout` seconds. Anything beyond that
				// means the connection stalled rather than long-polled, which is the
				// only way to tell a healthy quiet period from a wedged socket.
				if (pollMs > (POLL_SECONDS + 5) * 1000) {
					this.log.warn({ msg: "long poll overran its server-side timeout", pollMs, updates: updates.length });
				}

				if (this.stateValue === "degraded") {
					this.log.info({ msg: "polling recovered" });
					this.setState("running");
				}
				this.backoffMs = 1000;

				if (updates.length > 0) {
					this.log.info({
						msg: "updates received",
						count: updates.length,
						kinds: updates.map((u) =>
							u.message ? "message" : u.callback_query ? "callback" : u.edited_message ? "edited" : "other",
						),
					});
				}

				for (const update of updates) {
					// Advance past every update we were handed, including ones we
					// filter out — otherwise a stranger's message wedges the offset.
					this.offset = update.update_id + 1;
					if (!this.accept(update)) continue;
					try {
						this.opts.onUpdate(update);
					} catch (err) {
						this.log.error({ msg: "onUpdate threw", ...errFields(err) });
					}
				}
			} catch (err) {
				if (this.abort.signal.aborted) break;
				await this.handleLoopError(err);
			}
		}
		this.setState("stopped");
	}

	private accept(update: TgUpdate): boolean {
		const from = update.message?.from ?? update.callback_query?.from;
		if (!from) {
			this.log.warn({ msg: "dropping update with no sender", updateId: update.update_id });
			return false;
		}
		if (from.id !== this.opts.allowedUserId) {
			this.log.warn({ msg: "dropping update from non-allowlisted user" });
			return false;
		}
		const chat = update.message?.chat ?? update.callback_query?.message?.chat;
		// Sender allowlisting alone is insufficient: the operator can add the bot
		// to a group, where answers and local-system details would be visible to
		// every member. A one-operator daemon must stay in that operator's DM.
		if (chat && (chat.type !== "private" || chat.id !== this.opts.allowedUserId)) {
			this.log.warn({ msg: "dropping update outside the operator private chat" });
			return false;
		}
		if (update.edited_message) {
			this.log.info({ msg: "ignoring edited message", updateId: update.update_id });
			return false; // v1 does not re-run a turn for an edit
		}
		return true;
	}

	private async handleLoopError(err: unknown): Promise<void> {
		if (err instanceof TgError && err.kind === "fatal") {
			this.log.error({ msg: "fatal polling error", ...errFields(err) });
			this.opts.onFatal(err);
			this.abort.abort();
			return;
		}
		if (err instanceof TgError && err.kind === "conflict") {
			this.setState("degraded");
			// Telegram rate-limits 409 *delivery* to roughly one per 3s, so a
			// tight retry is pure thrash. Back off far enough that the other
			// consumer can finish, then re-run preflight in case a webhook
			// appeared rather than a competing poller.
			const wait = jitter(30_000, 30_000);
			this.log.error({ msg: "409 conflict — another consumer owns this bot token", waitMs: wait, ...errFields(err) });
			await sleep(wait, this.abort.signal);
			await this.preflight().catch((e: unknown) => this.log.warn({ msg: "preflight retry failed", ...errFields(e) }));
			return;
		}
		if (err instanceof TgError && err.kind === "throttled") {
			const wait = (err.retryAfter ?? 5) * 1000;
			this.log.warn({ msg: "polling throttled", waitMs: wait });
			await sleep(wait, this.abort.signal);
			return;
		}
		this.log.warn({ msg: "polling error, backing off", waitMs: this.backoffMs, ...errFields(err) });
		await sleep(this.backoffMs, this.abort.signal);
		this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
	}

	/** Aborts the in-flight long poll so shutdown doesn't wait out the 30s timeout. */
	stop(): void {
		this.abort.abort();
	}
}
