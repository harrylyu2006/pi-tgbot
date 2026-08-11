/**
 * Telegram HTML primitives.
 *
 * Telegram's HTML parse mode accepts a fixed, tiny tag set and rejects the
 * whole message with `400: can't parse entities` if anything is malformed.
 * While streaming we necessarily send prefixes of an unfinished document, so
 * the invariant that makes this safe is: every string handed to the API is
 * structurally closed. `closeOpenTags` is what enforces it.
 */

/** The only tags Telegram understands. Anything else must be escaped away. */
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "blockquote", "tg-spoiler"]);

/** Void of any tags: escape the three characters that can start markup. */
export function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute values additionally must not break out of their quotes. */
export function escAttr(value: string): string {
	return esc(value).replace(/"/g, "&quot;");
}

/**
 * Append the closers needed to make an arbitrary prefix of our own output
 * valid, and drop any dangling partial tag at the very end.
 *
 * Only tags we emit ourselves are tracked — user text is escaped before it ever
 * reaches here, so a `<script>` in the model's answer is already `&lt;script&gt;`.
 */
export function closeOpenTags(html: string): string {
	const stack: string[] = [];
	const tagRe = /<(\/?)([a-zA-Z-]+)((?:\s[^<>]*)?)>/g;
	let match: RegExpExecArray | null;
	let lastIndex = 0;

	while ((match = tagRe.exec(html)) !== null) {
		lastIndex = tagRe.lastIndex;
		const closing = match[1] === "/";
		const name = (match[2] ?? "").toLowerCase();
		if (!ALLOWED.has(name)) continue;
		if (closing) {
			const idx = stack.lastIndexOf(name);
			if (idx < 0) continue;
			// The requested close also implicitly closes any inner formatting. This
			// mirrors HTML parsing and prevents stale nested tags from being appended
			// after an already-closed outer blockquote/pre block.
			stack.splice(idx);
		} else {
			stack.push(name);
		}
	}

	// A trailing "<" or "<b" from a mid-write truncation would be parsed as text
	// containing a stray angle bracket, which Telegram rejects.
	let out = html;
	const tail = html.slice(lastIndex);
	const strayOpen = tail.lastIndexOf("<");
	if (strayOpen >= 0) out = html.slice(0, lastIndex + strayOpen);

	for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
	return out;
}

/** Strip every tag, for the plain-text fallback after a parse failure. */
export function stripTags(html: string): string {
	return html
		.replace(/<[^<>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}
