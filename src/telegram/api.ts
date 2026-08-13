/**
 * Bot API client on global fetch. No framework.
 *
 * Everything that talks to Telegram goes through `call()`, so error
 * classification, timeouts and abort wiring exist in exactly one place.
 */

import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { classifyApiError, classifyNetworkError, TgError } from "../errors.ts";
import { streamToFile } from "./files.ts";
import type { Logger } from "../log.ts";
import type {
	EditMessageTextParams,
	SendMessageParams,
	TgApiResponse,
	TgMessage,
	TgUpdate,
	TgUser,
	TgWebhookInfo,
} from "./types.ts";

export interface GetUpdatesParams {
	offset?: number;
	limit?: number;
	timeout?: number;
	allowed_updates?: string[];
}

export class TelegramApi {
	private readonly base: string;
	private readonly log: Logger;

	constructor(botToken: string, log: Logger) {
		this.base = `https://api.telegram.org/bot${botToken}`;
		this.log = log;
	}

	/**
	 * `timeoutMs` must exceed the long-poll `timeout` for getUpdates, otherwise
	 * we abort our own poll every cycle and hammer the server.
	 */
	/**
	 * One request, with a single retry on a stalled connection.
	 *
	 * This box tunnels a lot of traffic, and the path to api.telegram.org
	 * intermittently wedges: requests hang until they hit their budget exactly,
	 * for edits as well as long polls. Waiting for the next cycle would leave
	 * the operator staring at a stale message for a full timeout, so a timeout
	 * gets one immediate retry on a fresh connection.
	 */
	async call<T>(
		method: string,
		params: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; cosmetic?: boolean },
	): Promise<T> {
		try {
			return await this.callOnce<T>(method, params, opts);
		} catch (err) {
			const stalled = err instanceof TgError && err.kind === "transient" && /timeout|aborted/i.test(err.description);
			// A stalled typing bubble is not worth a second request, and retrying it
			// competes with the answer the operator is actually waiting for.
			if (!stalled || opts?.cosmetic || opts?.signal?.aborted) throw err;
			this.log.info({ msg: "retrying stalled request on a fresh connection", method });
			return await this.callOnce<T>(method, params, {
				...opts,
				headers: { ...(opts?.headers ?? {}), connection: "close" },
			});
		}
	}

	private async callOnce<T>(
		method: string,
		params: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; cosmetic?: boolean },
	): Promise<T> {
		// 15s, not 30s: a Bot API call that has not answered by then is stalled,
		// not slow. Observed stalls sit at exactly the budget, so a shorter
		// budget just means the retry on a fresh connection happens sooner.
		const timeoutMs = opts?.timeoutMs ?? 15_000;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
		const startedAt = Date.now();

		let res: Response;
		try {
			res = await fetch(`${this.base}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
				body: JSON.stringify(params),
				signal,
			});
		} catch (err) {
			// An externally requested abort is a shutdown, not a network fault.
			if (opts?.signal?.aborted) throw new TgError("fatal", `${method}: aborted`, { method, cause: err });
			// Elapsed time is the only way to tell "stalled socket" from "server
			// took a while": a stall lands exactly on our timeout, every time.
			// Cosmetic failures are logged at debug so they cannot drown out the
			// warnings that mean something is actually wrong.
			const level = opts?.cosmetic ? "debug" : "warn";
			this.log[level]({ msg: "request failed", method, elapsedMs: Date.now() - startedAt, budgetMs: timeoutMs, errName: err instanceof Error ? err.name : typeof err });
			throw classifyNetworkError(method, err);
		}

		let body: TgApiResponse<T> | undefined;
		try {
			body = (await res.json()) as TgApiResponse<T>;
		} catch {
			if (!res.ok) throw classifyApiError(method, res.status, undefined);
			throw new TgError("transient", `${method}: non-JSON response (HTTP ${res.status})`, { method, status: res.status });
		}

		if (!res.ok || !body.ok) throw classifyApiError(method, res.status, body);
		return body.result as T;
	}

	getMe(signal?: AbortSignal): Promise<TgUser> {
		return this.call<TgUser>("getMe", {}, { signal, timeoutMs: 15_000 });
	}

	getWebhookInfo(signal?: AbortSignal): Promise<TgWebhookInfo> {
		return this.call<TgWebhookInfo>("getWebhookInfo", {}, { signal, timeoutMs: 15_000 });
	}

	deleteWebhook(signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("deleteWebhook", { drop_pending_updates: false }, { signal, timeoutMs: 15_000 });
	}

	setMyCommands(commands: Array<{ command: string; description: string }>, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("setMyCommands", { commands }, { signal, timeoutMs: 15_000 });
	}

	/**
	 * Delete the command list for a scope/language. With no scope this clears the
	 * default menu; a previous bot under the same token may have left stale
	 * per-scope or per-language commands that `setMyCommands` alone does not erase.
	 */
	deleteMyCommands(params?: { scope?: unknown; language_code?: string }, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("deleteMyCommands", params ?? {}, { signal, timeoutMs: 15_000 });
	}

	/**
	 * Long poll.
	 *
	 * `connection: close` is deliberate. A kept-alive socket that Telegram has
	 * silently dropped looks identical to a slow long poll from the client side,
	 * and the only symptom is a request that hangs until our own timeout fires.
	 * At two requests a minute the extra TLS handshake costs nothing, and it
	 * removes that failure mode entirely.
	 */
	getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<TgUpdate[]> {
		const pollSeconds = params.timeout ?? 30;
		return this.call<TgUpdate[]>(
			"getUpdates",
			{ ...params },
			{ signal, timeoutMs: (pollSeconds + 10) * 1000, headers: { connection: "close" } },
		);
	}

	sendMessage(params: SendMessageParams, signal?: AbortSignal): Promise<TgMessage> {
		return this.call<TgMessage>("sendMessage", params as unknown as Record<string, unknown>, { signal });
	}

	editMessageText(params: EditMessageTextParams, signal?: AbortSignal): Promise<TgMessage | boolean> {
		return this.call<TgMessage | boolean>("editMessageText", params as unknown as Record<string, unknown>, { signal });
	}

	/**
	 * Every callback query must be answered within ~15s or the client shows a
	 * spinner forever, so this is called even on the rejection paths.
	 */
	answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>(
			"answerCallbackQuery",
			{ callback_query_id: id, ...(text ? { text, show_alert: false } : {}) },
			{ signal, timeoutMs: 10_000 },
		);
	}

	sendChatAction(chatId: number, action: string, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("sendChatAction", { chat_id: chatId, action }, { signal, timeoutMs: 8_000, cosmetic: true });
	}

	/**
	 * Download a file to disk, streaming rather than buffering — a 20MB upload
	 * held in memory on a box with other production services is avoidable waste.
	 */
	async downloadTo(filePath: string, dest: string): Promise<void> {
		const url = `${this.base.replace("/bot", "/file/bot")}/${filePath}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!res.ok) throw new TgError("transient", `download failed: HTTP ${res.status}`, { status: res.status, method: "getFile" });
		await streamToFile(res.body as ReadableStream<Uint8Array> | null, dest);
	}

	/**
	 * Stream one multipart upload without buffering the whole file in memory.
	 * `duplex: "half"` is required by Node fetch for streaming request bodies.
	 */
	async sendFile(chatId: number, path: string, kind: "photo" | "document", caption?: string): Promise<TgMessage> {
		const method = kind === "photo" ? "sendPhoto" : "sendDocument";
		const boundary = `----pi-tg-${randomUUID()}`;
		const filename = basename(path).replace(/["\r\n]/g, "_");
		const fields = [
			`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
			...(caption
				? [`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption.slice(0, 1024)}\r\n`]
				: []),
			`--${boundary}\r\nContent-Disposition: form-data; name="${kind}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		];
		const closing = `\r\n--${boundary}--\r\n`;
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(path, "r");
		} catch (err) {
			throw classifyNetworkError(method, err);
		}

		try {
			const openedStat = await file.stat();
			if (!openedStat.isFile()) throw new Error("outbound path is no longer a regular file");
			const contentLength = fields.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + openedStat.size + Buffer.byteLength(closing);
			const body = ReadableStream.from((async function* (): AsyncGenerator<Uint8Array> {
				for (const field of fields) yield Buffer.from(field);
				for await (const chunk of createReadStream("", { fd: file.fd, autoClose: false })) yield chunk as Buffer;
				yield Buffer.from(closing);
			})());
			const res = await fetch(`${this.base}/${method}`, {
				method: "POST",
				headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(contentLength) },
				body,
				duplex: "half",
				signal: AbortSignal.timeout(180_000),
			});
			let response: TgApiResponse<TgMessage> | undefined;
			try {
				response = (await res.json()) as TgApiResponse<TgMessage>;
			} catch {
				if (!res.ok) throw classifyApiError(method, res.status, undefined);
				throw new TgError("transient", `${method}: non-JSON response (HTTP ${res.status})`, { method, status: res.status });
			}
			if (!res.ok || !response.ok) throw classifyApiError(method, res.status, response);
			return response.result as TgMessage;
		} catch (err) {
			if (err instanceof TgError) throw err;
			throw classifyNetworkError(method, err);
		} finally {
			await file.close().catch(() => undefined);
		}
	}
}
