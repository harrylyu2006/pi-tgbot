/**
 * Packing compiled blocks into transport-sized messages.
 *
 * Because `compileBlocks` hands us independently closed blocks, the common case
 * is pure packing — no HTML is ever cut. Only a single oversized block needs
 * splitting, and the one that actually gets oversized in practice is a code
 * block, which we reopen with the same language on the next piece.
 */

import { closeOpenTags } from "./html.ts";

const CODE_OPEN = /^<pre><code(?: class="language-[^"]*")?>/;

function splitOversizedBlock(block: string, max: number): string[] {
	const out: string[] = [];

	const codeMatch = CODE_OPEN.exec(block);
	if (codeMatch && block.endsWith("</code></pre>")) {
		const open = codeMatch[0];
		const close = "</code></pre>";
		const body = block.slice(open.length, block.length - close.length);
		const budget = max - open.length - close.length;
		let current: string[] = [];
		let size = 0;
		for (const line of body.split("\n")) {
			// A single line longer than the budget is hard-cut; nothing better is
			// available and losing it silently would be worse.
			const piece = line.length > budget ? line.slice(0, budget) : line;
			if (size + piece.length + 1 > budget && current.length > 0) {
				out.push(open + current.join("\n") + close);
				current = [];
				size = 0;
			}
			current.push(piece);
			size += piece.length + 1;
		}
		if (current.length > 0) out.push(open + current.join("\n") + close);
		return out;
	}

	// Non-code block: cut on line boundaries and let closeOpenTags repair the
	// inline markup that straddles the cut.
	let current = "";
	for (const line of block.split("\n")) {
		if (current.length + line.length + 1 > max && current.length > 0) {
			out.push(closeOpenTags(current));
			current = "";
		}
		current += (current ? "\n" : "") + line;
	}
	if (current) out.push(closeOpenTags(current));
	return out;
}

/** Pack every block, in order, into messages no larger than `max`. */
export function packBlocks(blocks: string[], max: number): string[] {
	const chunks: string[] = [];
	let current = "";

	for (const block of blocks) {
		const pieces = block.length > max ? splitOversizedBlock(block, max) : [block];
		for (const piece of pieces) {
			if (current.length + piece.length + 2 > max && current.length > 0) {
				chunks.push(current);
				current = "";
			}
			current += (current ? "\n\n" : "") + piece;
		}
	}
	if (current) chunks.push(current);
	return chunks.length > 0 ? chunks : [""];
}

/**
 * The tail view used while streaming: newest content is the interesting part,
 * so older blocks are dropped rather than the message being truncated at the
 * front of the answer.
 */
export function packTail(blocks: string[], max: number, elidedNote = "…（前文见后续消息）"): string {
	const kept: string[] = [];
	let size = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i] ?? "";
		const cost = block.length + 2;
		if (size + cost > max) {
			if (kept.length === 0) {
				// Even one block does not fit: show its tail, repaired.
				const pieces = splitOversizedBlock(block, max - elidedNote.length - 2);
				const last = pieces[pieces.length - 1] ?? "";
				return `${elidedNote}\n\n${last}`;
			}
			return `${elidedNote}\n\n${kept.join("\n\n")}`;
		}
		kept.unshift(block);
		size += cost;
	}
	return kept.join("\n\n");
}
