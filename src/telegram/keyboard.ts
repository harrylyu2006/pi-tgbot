/**
 * Inline keyboards and the callback_data codec.
 *
 * `callback_data` is capped at 64 bytes by Telegram, and buttons live forever
 * in the chat history — a tap can arrive hours later, after a restart or a
 * `/new`. So every payload carries the boot id and the session generation it
 * was minted under, and a stale tap is answered with a toast instead of
 * silently doing something to a session the operator is no longer looking at.
 */

export interface Callback {
	action: string;
	arg: string;
	boot: string;
	gen: number;
}

const SEP = "|";
const VERSION = "1";
const longArgs = new Map<string, string>();
let nextArg = 0;

/** Boot id: distinct per process, short enough to fit the 64-byte budget. */
export function makeBootId(startedAtMs: number): string {
	return startedAtMs.toString(36).slice(-6);
}

export function encodeCallback(action: string, arg: string, boot: string, gen: number): string {
	const data = [VERSION, boot, String(gen), action, arg].join(SEP);
	if (Buffer.byteLength(data, "utf8") <= 64 && !arg.startsWith("~")) return data;
	// A clipped model id can never resolve. Store a process-local opaque reference;
	// boot/generation fencing still rejects old buttons and bounded eviction fails closed.
	const ref = `~${(++nextArg).toString(36)}`;
	const encoded = [VERSION, boot, String(gen), action, ref].join(SEP);
	if (Buffer.byteLength(encoded, "utf8") > 64) throw new Error("Callback header exceeds Telegram limit");
	longArgs.set(encoded, arg);
	if (longArgs.size > 2048) longArgs.delete(longArgs.keys().next().value!);
	return encoded;
}

export function decodeCallback(data: string | undefined): Callback | null {
	if (!data) return null;
	const parts = data.split(SEP);
	if (parts.length < 5 || parts[0] !== VERSION) return null;
	const gen = Number(parts[2]);
	if (!Number.isSafeInteger(gen) || gen < 0) return null;
	const rawArg = parts.slice(4).join(SEP);
	const arg = rawArg.startsWith("~") ? longArgs.get(data) : rawArg;
	if (arg === undefined) return null;
	return { boot: parts[1] ?? "", gen, action: parts[3] ?? "", arg };
}

export interface Button {
	text: string;
	data: string;
}

export function keyboard(rows: Button[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
	return { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

/** Lay buttons out in rows of `perRow`, preserving order. */
export function grid(buttons: Button[], perRow: number): Button[][] {
	const rows: Button[][] = [];
	for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
	return rows;
}
