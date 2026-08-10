/**
 * M1 rendering helpers: plain text only.
 *
 * M1 deliberately sends no `parse_mode`. Markdown→HTML compilation and the
 * closed-tag invariant are M3's job, and entangling them with "does the SDK
 * wiring work at all" is how a vertical slice stops being a vertical slice.
 * The one rule that already matters is the 4096-char transport limit.
 */

/** Telegram counts UTF-16 code units, which is what `.length` gives us. */
export function tgLength(s: string): number {
	return s.length;
}

/**
 * Truncate for a *live* frame: we show the tail of the answer as it grows,
 * because the newest text is the interesting part while streaming.
 */
export function truncateHead(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "…（前文已省略）\n";
	return marker + text.slice(text.length - (maxChars - marker.length));
}

/**
 * Split a finished body into transport-sized pieces, preferring paragraph then
 * line boundaries so a code block or list is less likely to be cut mid-item.
 */
export function splitForTransport(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const out: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		let cut = window.lastIndexOf("\n\n");
		if (cut < maxChars * 0.5) cut = window.lastIndexOf("\n");
		if (cut < maxChars * 0.5) cut = window.lastIndexOf(" ");
		if (cut <= 0) cut = maxChars;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).replace(/^\s+/, "");
	}
	if (rest.length > 0) out.push(rest);
	return out;
}

/** Collapse whitespace and clip, for one-line status rows. */
export function oneLine(text: string, maxChars = 90): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}
