/** Durable final-answer outbox. Never re-run a model/tool to retry delivery. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isBadEntities, TgError } from "../errors.ts";
import { stripTags } from "./html.ts";
import type { TelegramApi } from "./api.ts";

export interface PendingDelivery {
	id: string;
	chatId: number;
	chunks: string[];
	next: number;
}

export class DeliveryStore {
	private records: PendingDelivery[] = [];
	private readonly path: string;
	constructor(path: string) { this.path = path; }
	load(): void {
		try {
			const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!Array.isArray(data) || !data.every((r) => r && typeof r.id === "string" && Number.isSafeInteger(r.chatId)
				&& Array.isArray(r.chunks) && r.chunks.every((c: unknown) => typeof c === "string")
				&& Number.isInteger(r.next) && r.next >= 0 && r.next <= r.chunks.length)) throw new Error("Invalid delivery outbox");
			this.records = data;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	private save(records: PendingDelivery[]): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(`${this.path}.tmp`, JSON.stringify(records), { mode: 0o600, flush: true });
		renameSync(`${this.path}.tmp`, this.path);
		this.records = records;
	}
	create(chatId: number, chunks: string[]): PendingDelivery {
		const record = { id: randomUUID(), chatId, chunks: [...chunks], next: 0 };
		this.save([...this.records, record]);
		return record;
	}
	advance(id: string, next: number): void {
		this.save(this.records.flatMap((r) => r.id !== id ? [r] : next >= r.chunks.length ? [] : [{ ...r, next }]));
	}
	pending(chatId?: number): PendingDelivery[] {
		return this.records.filter((r) => chatId === undefined || r.chatId === chatId).map((r) => ({ ...r, chunks: [...r.chunks] }));
	}
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Only explicit 429 rejection is safe to retry for non-idempotent sends. */
export async function retryThrottled<T>(operation: () => Promise<T>, wait = sleep): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try { return await operation(); }
		catch (err) {
			if (!(err instanceof TgError) || err.kind !== "throttled" || attempt >= 3) throw err;
			await wait(Math.max(1, err.retryAfter ?? 5) * 1000 + 250);
		}
	}
}

export async function sendChunk(api: TelegramApi, chatId: number, html: string, wait = sleep): Promise<void> {
	let plain = false;
	await retryThrottled(async () => {
		try {
			await api.sendMessage({ chat_id: chatId, text: plain ? stripTags(html) : html,
				...(plain ? {} : { parse_mode: "HTML" as const }), link_preview_options: { is_disabled: true } });
		} catch (err) {
			if (!plain && isBadEntities(err)) {
				plain = true;
				await api.sendMessage({ chat_id: chatId, text: stripTags(html), link_preview_options: { is_disabled: true } });
			} else throw err;
		}
	}, wait);
}

export async function retryPendingDelivery(api: TelegramApi, store: DeliveryStore, chatId: number, wait = sleep): Promise<void> {
	for (const record of store.pending(chatId)) {
		for (let i = record.next; i < record.chunks.length; i++) {
			await sendChunk(api, chatId, record.chunks[i]!, wait);
			store.advance(record.id, i + 1);
		}
	}
}
