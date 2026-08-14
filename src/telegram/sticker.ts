/**
 * Sticker preprocessing: turn Telegram sticker files into something the
 * model can work with.
 *
 * - Static stickers arrive as .webp — multimodal models inspect them via native
 *   `read`, text-only models fall back to the image-describe skill (OpenRouter).
 * - Animated stickers arrive as .tgs — a gzip-compressed Lottie JSON. We
 *   extract the text layers so the model gets the actual words without
 *   needing a renderer; the raw path is still included for deeper digs.
 * - Video stickers arrive as .webm — we extract the first frame to a jpg
 *   (needs ffmpeg) so the vision path works for them too.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Logger } from "../log.ts";

/** Hard ceilings so a hostile/weird file cannot blow us up during unpacking. */
const MAX_TGS_BYTES = 5 * 1024 * 1024; // on-disk (compressed)
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024; // after gunzip

export interface PreparedSticker {
	/** Paths to hand to the model, most useful first. */
	paths: string[];
	/** Text extracted from animated (tgs) sticker layers, deduped, in order. */
	lottieText: string[];
}

/**
 * Preprocess one downloaded sticker file in place (writes a sibling jpg for
 * webm). Never throws for content problems — a weird file just yields the raw
 * path and no text.
 */
export async function prepareStickerFile(filePath: string, log: Logger): Promise<PreparedSticker> {
	const lower = filePath.toLowerCase();

	if (lower.endsWith(".tgs")) {
		return { paths: [filePath], lottieText: extractTgsText(filePath, log) };
	}

	if (lower.endsWith(".webm")) {
		const frame = await extractFirstFrame(filePath, log);
		return frame ? { paths: [frame, filePath], lottieText: [] } : { paths: [filePath], lottieText: [] };
	}

	// Static webp (and anything unexpected): the model sees the path directly.
	return { paths: [filePath], lottieText: [] };
}

/**
 * A .tgs file is Lottie JSON compressed with gzip. Text layers are objects
 * with `ty === 5`; their value lives at `t.d.k[].s.t`. Walk the whole tree
 * defensively — bad JSON, wrong shape or oversize all degrade to no text.
 */
function extractTgsText(filePath: string, log: Logger): string[] {
	try {
		if (!existsSync(filePath)) return [];
		const buf = readFileSync(filePath);
		if (buf.length === 0 || buf.length > MAX_TGS_BYTES) return [];

		const json = gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES });
		const doc: unknown = JSON.parse(json.toString("utf8"));

		const texts = new Set<string>();
		walk(doc, (node) => {
			if (!isRecord(node) || node.ty !== 5) return;
			const t = node.t;
			if (!isRecord(t)) return;
			const d = t.d;
			if (!isRecord(d) || !Array.isArray(d.k)) return;
			for (const k of d.k) {
				if (!isRecord(k)) continue;
				const s = k.s;
				if (isRecord(s) && typeof s.t === "string" && s.t.trim()) texts.add(s.t.trim());
			}
		});
		return [...texts];
	} catch (err) {
		// Not gzip, not JSON, truncated, oversize — whatever it is, the model
		// still gets the raw path and can investigate.
		log.warn({ msg: "tgs text extraction failed, using raw path", errName: err instanceof Error ? err.name : typeof err });
		return [];
	}
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (isRecord(node)) {
		visit(node);
		for (const value of Object.values(node)) walk(value, visit);
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the first video frame out of a webm sticker with ffmpeg. */
function extractFirstFrame(filePath: string, log: Logger): Promise<string | null> {
	const out = join(filePath.replace(/\.webm$/i, "") + ".jpg");
	return new Promise((resolve) => {
		execFile(
			"ffmpeg",
			["-y", "-i", filePath, "-frames:v", "1", "-q:v", "3", out],
			{ timeout: 20_000, windowsHide: true },
			(err) => {
				if (err) {
					log.warn({ msg: "webm first-frame extraction failed, using raw path", errName: err.name });
					resolve(null);
					return;
				}
				resolve(existsSync(out) ? out : null);
			},
		);
	});
}
