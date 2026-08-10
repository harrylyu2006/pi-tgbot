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

/** Boot id: distinct per process, short enough to fit the 64-byte budget. */
export function makeBootId(startedAtMs: number): string {
	return startedAtMs.toString(36).slice(-6);
}

export function encodeCallback(action: string, arg: string, boot: string, gen: number): string {
	const data = [VERSION, boot, String(gen), action, arg].join(SEP);
	if (Buffer.byteLength(data, "utf8") <= 64) return data;
	// Truncating the argument is safe: every consumer re-resolves it against the
	// live list rather than trusting it, so a clipped value simply misses.
	const overflow = Buffer.byteLength(data, "utf8") - 64;
	return [VERSION, boot, String(gen), action, arg.slice(0, Math.max(0, arg.length - overflow))].join(SEP);
}

export function decodeCallback(data: string | undefined): Callback | null {
	if (!data) return null;
	const parts = data.split(SEP);
	if (parts.length < 5 || parts[0] !== VERSION) return null;
	return { boot: parts[1] ?? "", gen: Number(parts[2] ?? "0"), action: parts[3] ?? "", arg: parts.slice(4).join(SEP) };
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
