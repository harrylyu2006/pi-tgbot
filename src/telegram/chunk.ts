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

function hardSplit(text: string, max: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
	return out;
}

function splitOversizedBlock(block: string, max: number): string[] {
	const out: string[] = [];
	if (max <= 0) return [""];

	const codeMatch = CODE_OPEN.exec(block);
	if (codeMatch && block.endsWith("</code></pre>")) {
		const open = codeMatch[0];
		const close = "</code></pre>";
		const body = block.slice(open.length, block.length - close.length);
		const budget = max - open.length - close.length;
		if (budget <= 0) return hardSplit(block, max);
		let current = "";
		const flush = (): void => {
			if (!current) return;
			out.push(open + current + close);
			current = "";
		};
		for (const line of body.split("\n")) {
			const pieces = line.length > budget ? hardSplit(line, budget) : [line];
			for (const piece of pieces) {
				const candidate = current ? `${current}\n${piece}` : piece;
				if (candidate.length > budget) flush();
				current = current ? `${current}\n${piece}` : piece;
				if (current.length === budget) flush();
			}
		}
		flush();
		return out;
	}

	// Non-code block: cut on line boundaries, then hard-split an individual
	// oversized line. Every resulting chunk is bounded; no content is dropped.
	let current = "";
	for (const line of block.split("\n")) {
		const pieces = line.length > max ? hardSplit(line, max) : [line];
		for (const piece of pieces) {
			if (current.length + piece.length + (current ? 1 : 0) > max) {
				out.push(closeOpenTags(current));
				current = "";
			}
			current += (current ? "\n" : "") + piece;
			if (current.length === max) {
				out.push(closeOpenTags(current));
				current = "";
			}
		}
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
