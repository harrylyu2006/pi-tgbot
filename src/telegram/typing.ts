/**
 * "typing…" keepalive.
 *
 * Telegram's typing indicator expires about 5 seconds after each
 * `sendChatAction`, so showing it for a multi-minute turn means re-arming it
 * continuously. 4s gives a margin without doubling the request rate.
 *
 * Failures here are cosmetic by definition: a turn must never fail because the
 * typing bubble could not be refreshed, and a 429 on this endpoint must not eat
 * into the budget the real answer needs — so it backs off and stays quiet.
 */

import { TgError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { TelegramApi } from "./api.ts";

const REFRESH_MS = 4000;

export class TypingIndicator {
	private readonly api: TelegramApi;
	private readonly log: Logger;
	private timer: NodeJS.Timeout | null = null;
	private chatId: number | null = null;
	private inFlight = false;
	private suppressedUntil = 0;

	constructor(api: TelegramApi, log: Logger) {
		this.api = api;
		this.log = log;
	}

	start(chatId: number): void {
		this.stop();
		this.chatId = chatId;
		void this.ping();
		// Unref'd on purpose — unlike the poller's backoff, this timer is pure
		// decoration and must never be the reason the process stays alive.
		this.timer = setInterval(() => void this.ping(), REFRESH_MS);
		this.timer.unref?.();
	}

	private async ping(): Promise<void> {
		if (this.chatId === null || this.inFlight) return;
		if (Date.now() < this.suppressedUntil) return;
		this.inFlight = true;
		try {
			await this.api.sendChatAction(this.chatId, "typing");
		} catch (err) {
			if (err instanceof TgError && err.kind === "throttled") {
				this.suppressedUntil = Date.now() + (err.retryAfter ?? 5) * 1000;
			} else {
				this.log.debug({ msg: "typing action failed", err: String(err).slice(0, 120) });
			}
		} finally {
			this.inFlight = false;
		}
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.chatId = null;
	}
}
