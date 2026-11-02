/**
 * Output scrubber: replaces any stored secret (and its common encodings) with
 * `[SECRET:name]`. This is a safety net against *accidents* — verbose error
 * messages, `curl -v`, a page snapshot echoing a typed value. It is not a
 * defence against an agent that is actively trying to smuggle a value out
 * (`echo $X | rev` defeats any string matcher); the per-secret "confirm each
 * use" flag and the audit log are the controls for that.
 */

import { MIN_SCRUB_LEN } from "./vault.ts";

export function needlesFor(value: string): string[] {
	const out = new Set<string>();
	const add = (s: string): void => { if (s.length >= MIN_SCRUB_LEN) out.add(s); };
	add(value);
	add(value.trim());
	add(JSON.stringify(value).slice(1, -1));
	try { add(encodeURIComponent(value)); } catch { /* lone surrogate: skip */ }
	const buf = Buffer.from(value, "utf8");
	add(buf.toString("base64"));
	add(buf.toString("base64").replace(/=+$/, ""));
	add(buf.toString("base64url"));
	add(value.replaceAll("'", "'\\''"));
	if (/[\r\n]/.test(value)) {
		for (const line of value.split(/\r?\n/)) if (line.trim().length >= 12) add(line.trim());
	}
	return [...out];
}

type Needle = { needle: string; name: string };
const MAX_EPHEMERAL = 500;

export class Scrubber {
	private needles: Needle[] = [];
	private base: Needle[] = [];
	/** Values resolved on demand (KeePass entries, TOTP codes): scrubbed from the moment they are read. */
	private ephemeral = new Map<string, { needles: Needle[]; expires: number }>();

	private compile(): void {
		const now = Date.now();
		for (const [key, e] of this.ephemeral) if (e.expires <= now) this.ephemeral.delete(key);
		const all = [...this.base, ...[...this.ephemeral.values()].flatMap((e) => e.needles)];
		// Longest first, so a base64 form is replaced before a shorter substring of it can fragment it.
		this.needles = all.sort((a, b) => b.needle.length - a.needle.length);
	}

	rebuild(values: Array<{ name: string; value: string }>): void {
		const list: Needle[] = [];
		for (const { name, value } of values) for (const needle of needlesFor(value)) list.push({ needle, name });
		this.base = list;
		this.compile();
	}

	/**
	 * Start scrubbing a value that is not stored in the vault. Call this *before* the value is handed to
	 * anything that could echo it. `ttlMs` bounds short-lived values (a TOTP code); passwords stay until restart
	 * (bounded by MAX_EPHEMERAL, oldest first).
	 */
	addEphemeral(name: string, value: string, ttlMs = Infinity): void {
		const needles = needlesFor(value).map((needle) => ({ needle, name }));
		if (!needles.length) return;
		this.ephemeral.delete(name);
		this.ephemeral.set(name, { needles, expires: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
		while (this.ephemeral.size > MAX_EPHEMERAL) this.ephemeral.delete(this.ephemeral.keys().next().value!);
		this.compile();
	}

	get active(): boolean {
		if (this.ephemeral.size) this.compile();
		return this.needles.length > 0;
	}

	scrub(text: string): string {
		if (this.ephemeral.size) this.compile();
		let out = text;
		for (const { needle, name } of this.needles) {
			if (out.includes(needle)) out = out.split(needle).join(`[SECRET:${name}]`);
		}
		return out;
	}

	/** Deep-scrub every string in a JSON-like structure. Returns the same reference when nothing changed. */
	scrubDeep<T>(value: T): T {
		if (!this.active) return value;
		const walk = (v: unknown): unknown => {
			if (typeof v === "string") return this.scrub(v);
			if (Array.isArray(v)) {
				let changed = false;
				const next = v.map((x) => { const y = walk(x); if (y !== x) changed = true; return y; });
				return changed ? next : v;
			}
			if (v && typeof v === "object") {
				const proto = Object.getPrototypeOf(v);
				if (proto !== Object.prototype && proto !== null) return v;
				let changed = false;
				const next: Record<string, unknown> = {};
				for (const [k, x] of Object.entries(v)) { const y = walk(x); if (y !== x) changed = true; next[k] = y; }
				return changed ? next : v;
			}
			return v;
		};
		return walk(value) as T;
	}
}
