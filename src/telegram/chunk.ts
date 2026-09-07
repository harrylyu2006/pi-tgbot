/** Split compiled HTML without cutting a tag, entity or Unicode code point. */
import { esc, stripTags } from "./html.ts";

interface Tag { name: string; open: string }
const TOKEN = /<\/?[a-zA-Z-]+(?:\s[^<>]*)?>|&(?:amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);|[\s\S]/gu;

function splitBlock(block: string, max: number): string[] {
	const out: string[] = [];
	const stack: Tag[] = [];
	let current = "";
	let hasText = false;
	const closing = (): string => stack.map((t) => `</${t.name}>`).reverse().join("");
	const opening = (): string => stack.map((t) => t.open).join("");
	const flush = (): void => {
		if (hasText) out.push(current + closing());
		current = opening();
		hasText = false;
	};
	for (const token of block.match(TOKEN) ?? []) {
		const tag = /^<(\/?)([a-zA-Z-]+)(?:\s[^<>]*)?>$/.exec(token);
		if (tag) {
			const name = tag[2]!;
			if (tag[1]) {
				if (stack.at(-1)?.name !== name) return splitPlain(block, max);
				stack.pop();
				current += token;
			} else {
				if (current.length + token.length + closing().length + name.length + 3 > max) flush();
				stack.push({ name, open: token });
				current += token;
				// Very long href / deeply nested wrappers: fall back without losing text.
				if (current.length + closing().length + 6 > max) return splitPlain(block, max);
			}
		} else {
			if (current.length + token.length + closing().length > max) flush();
			if (current.length + token.length + closing().length > max) return splitPlain(block, max);
			current += token;
			hasText = true;
		}
	}
	if (hasText) out.push(current + closing());
	return out;
}

function splitPlain(html: string, max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const char of stripTags(html)) {
		const token = esc(char);
		if (current.length + token.length > max) { out.push(current); current = ""; }
		if (token.length > max) throw new RangeError("HTML chunk budget is too small");
		current += token;
	}
	if (current) out.push(current);
	return out;
}

/** Pack every block in order. Joining split block text preserves its exact contents. */
export function packBlocks(blocks: string[], max: number): string[] {
	if (!Number.isInteger(max) || max < 8) throw new RangeError("Invalid HTML chunk budget");
	const chunks: string[] = [];
	let current = "";
	for (const block of blocks) {
		const pieces = block.length > max ? splitBlock(block, max) : [block];
		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i]!;
			if (current && (i > 0 || current.length + piece.length + 2 > max)) {
				chunks.push(current);
				current = "";
			}
			current += (current ? "\n\n" : "") + piece;
		}
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [""];
}

/** Tail preview reserves space for the elision note before packing. */
export function packTail(blocks: string[], max: number, elidedNote = "…（前文见后续消息）"): string {
	const full = blocks.join("\n\n");
	if (full.length <= max) return full;
	const note = esc(elidedNote) + "\n\n";
	const chunks = packBlocks(blocks, max - note.length);
	return note + (chunks.at(-1) ?? "");
}
