/**
 * Read-only KeePass (KDBX 3/4) access.
 *
 * Design rules, in the order they matter:
 *  - The database is never written. The file on disk is a copy the operator hands over; this module only reads it.
 *  - Passwords are *resolved*, never *returned to the model*. `search` yields titles, usernames, URLs and tags;
 *    a secret is only produced by `get`, which the harness calls when substituting into `secret_run` or a
 *    `{{secret:kp:ID#field}}` placeholder.
 *  - Unlocking is a deliberate act. In "session" mode the master password lives in memory only, for a bounded idle
 *    time, and is not kept after the database is parsed (only the decrypted entries are, protected-value style).
 *  - Entries tagged `hiddenTag` (and groups in `hiddenGroups`, and the Recycle Bin) do not exist as far as the
 *    agent is concerned; entries tagged `confirmTag` need an operator tap on each use.
 *
 * Argon2 comes from Node's own `crypto.argon2` (no WASM, no native add-on).
 */

import * as kdbxweb from "kdbxweb";
import { argon2 } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { parseOtpAuth, timeOtpParams, totpAt, totpRemaining, TotpError, type TotpParams } from "./totp.ts";
import { MAX_VALUE_BYTES } from "./vault.ts";
import { KP_REF, KeepassError, looksLikeKdbx, type EntryInfo, type InstallMeta, type KeepassConfig, type Resolved } from "./keepass-core.ts";

// Re-exported so that existing imports of these names from "./keepass.ts" keep working.
export { KP_REF, KeepassError, looksLikeKdbx };
export type { EntryInfo, InstallMeta, KeepassConfig, KeepassErrorCode, Resolved } from "./keepass-core.ts";

const RESERVED = new Set(["title", "username", "password", "url", "notes", "otp"]);
/**
 * Memory the process could still allocate before its cgroup limit (or, outside a cgroup, the host's free RAM).
 * Page cache is reclaimable, so it is not counted as used. Infinity when it cannot be determined.
 */
export function defaultMemoryHeadroom(): number {
	try {
		const rel = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3).trim() ?? "";
		const dir = `/sys/fs/cgroup${rel}`;
		const max = readFileSync(`${dir}/memory.max`, "utf8").trim();
		if (max === "max") return freemem();
		const stat = new Map(readFileSync(`${dir}/memory.stat`, "utf8").split("\n").map((l) => l.split(" ") as [string, string]));
		const cache = Number(stat.get("inactive_file") ?? 0) + Number(stat.get("active_file") ?? 0);
		return Number(max) - (Number(readFileSync(`${dir}/memory.current`, "utf8")) - cache);
	} catch { return freemem(); }
}
let memoryProbe: () => number = defaultMemoryHeadroom;
/** Tests only. */
export function setMemoryProbe(fn: (() => number) | null): void { memoryProbe = fn ?? defaultMemoryHeadroom; }

let argonLimitKiB = 256 * 1024;
let argonReady = false;
function installArgon2(maxMiB: number): void {
	argonLimitKiB = maxMiB * 1024;
	if (argonReady) return;
	const run = promisify(argon2);
	kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
		if (version !== 0x13) throw new KeepassError("unsupported", "this database uses Argon2 version 1.0, which is not supported");
		if (memory > argonLimitKiB) throw new KeepassError("too-big", `the database's Argon2 memory cost (${Math.round(memory / 1024)} MiB) is above this service's ${Math.round(argonLimitKiB / 1024)} MiB safety limit (secrets.keepass.maxArgonMiB)`);
		// Argon2 allocates its whole working set up front. If that would push the service past its memory cap the kernel
		// kills the entire bot, so decline cleanly instead and let the operator retry when the service is quieter.
		if (memoryProbe() < memory * 1024 * 1.25 + 64 * 1024 * 1024) throw new KeepassError("too-big", `not enough free memory to open the database right now (it needs about ${Math.round(memory / 1024)} MiB); try again in a minute`);
		const algorithm = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? "argon2id" : "argon2d";
		const out = await run(algorithm, { message: Buffer.from(password), nonce: Buffer.from(salt), parallelism, tagLength: length, memory, passes: iterations });
		return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
	});
	argonReady = true;
}

const hexOf = (uuid: kdbxweb.KdbxUuid): string => Buffer.from(uuid.id, "base64").toString("hex");
const text = (v: unknown): string => (v instanceof kdbxweb.ProtectedValue ? v.getText() : typeof v === "string" ? v : v == null ? "" : String(v));
const sameGroup = (path: string, prefixes: string[]): boolean =>
	prefixes.some((p) => { const q = p.replace(/^\/+|\/+$/g, "").toLowerCase(); const g = path.toLowerCase(); return g === q || g.startsWith(`${q}/`); });

interface Rec { id: string; entry: kdbxweb.KdbxEntry; info: EntryInfo }

export class Keepass {
	readonly cfg: KeepassConfig;
	private db: kdbxweb.Kdbx | null = null;
	private index: Rec[] = [];
	private unlockedAt = 0;
	private lastUse = 0;
	private unlocking: Promise<number> | null = null;
	/** entry id → fields used since this unlock (cleared on lock). */
	private used = new Map<string, Set<string>>();
	private timer: NodeJS.Timeout | null = null;
	private readonly onLocked: (reason: "idle" | "max" | "manual" | "replaced") => void;
	private readonly now: () => number;

	constructor(cfg: KeepassConfig, hooks: { onLocked?: (reason: "idle" | "max" | "manual" | "replaced") => void; now?: () => number } = {}) {
		this.cfg = cfg;
		this.onLocked = hooks.onLocked ?? (() => {});
		this.now = hooks.now ?? Date.now;
	}

	get unlocked(): boolean { return this.db !== null; }
	get entryCount(): number { return this.index.length; }

	fileInfo(): { exists: boolean; bytes: number; mtimeMs: number } {
		try { const st = statSync(this.cfg.path); return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs }; }
		catch { return { exists: false, bytes: 0, mtimeMs: 0 }; }
	}

	status(): { unlocked: boolean; entries: number; idleLeftSec: number; maxLeftSec: number; mode: string; file: ReturnType<Keepass["fileInfo"]> } {
		const now = this.now();
		return {
			unlocked: this.unlocked, entries: this.index.length, mode: this.cfg.mode, file: this.fileInfo(),
			idleLeftSec: this.unlocked ? Math.max(0, Math.round((this.lastUse + this.cfg.idleMinutes * 60_000 - now) / 1000)) : 0,
			maxLeftSec: this.unlocked ? Math.max(0, Math.round((this.unlockedAt + this.cfg.maxHours * 3_600_000 - now) / 1000)) : 0,
		};
	}

	/** Read, decrypt and index the database. Resolves with the number of entries the agent can see. */
	unlock(password: string): Promise<number> {
		if (this.unlocking) return this.unlocking;
		this.unlocking = this.doUnlock(password).finally(() => { this.unlocking = null; });
		return this.unlocking;
	}

	private async doUnlock(password: string): Promise<number> {
		installArgon2(this.cfg.maxArgonMiB);
		const info = this.fileInfo();
		if (!info.exists) throw new KeepassError("no-file", "no KeePass database has been provided yet");
		if (info.bytes > this.cfg.maxFileMb * 1024 * 1024) throw new KeepassError("too-big", `database file is larger than ${this.cfg.maxFileMb} MB`);
		const buf = readFileSync(this.cfg.path);
		if (!looksLikeKdbx(buf)) throw new KeepassError("bad-file", "the stored file is not a KDBX 3/4 database (KeePass 1.x .kdb is not supported)");
		let db: kdbxweb.Kdbx;
		try {
			const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
			db = await kdbxweb.Kdbx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, cred);
		} catch (err) {
			if (err instanceof KeepassError) throw err;
			const code = (err as { code?: string }).code;
			if (code === kdbxweb.Consts.ErrorCodes.InvalidKey) throw new KeepassError("wrong-password", "wrong master password (or the database also needs a key file, which is not supported yet)");
			if (code === kdbxweb.Consts.ErrorCodes.FileCorrupt || code === kdbxweb.Consts.ErrorCodes.BadSignature || code === kdbxweb.Consts.ErrorCodes.InvalidVersion || code === kdbxweb.Consts.ErrorCodes.Unsupported) {
				throw new KeepassError("bad-file", `the database file could not be read (${code})`);
			}
			throw new KeepassError("bad-file", "the database file could not be read");
		}
		this.db = db;
		this.index = this.buildIndex(db);
		this.used.clear();
		this.unlockedAt = this.lastUse = this.now();
		this.startTimer();
		return this.index.length;
	}

	private buildIndex(db: kdbxweb.Kdbx): Rec[] {
		const out: Rec[] = [];
		const recycle = db.meta.recycleBinEnabled !== false ? db.meta.recycleBinUuid : undefined;
		const hiddenTag = this.cfg.hiddenTag.toLowerCase(), confirmTag = this.cfg.confirmTag.toLowerCase();
		const walk = (g: kdbxweb.KdbxGroup, path: string[]): void => {
			if (recycle && !recycle.empty && g.uuid.equals(recycle)) return;
			if (g.enableSearching === false) return;
			const groupPath = path.join("/");
			if (sameGroup(groupPath, this.cfg.hiddenGroups)) return;
			for (const e of g.entries) {
				const tags = (e.tags ?? []).map((t) => t.trim()).filter(Boolean);
				if (tags.some((t) => t.toLowerCase() === hiddenTag)) continue;
				const extra: string[] = [];
				for (const k of e.fields.keys()) if (!RESERVED.has(k.toLowerCase()) && !k.toLowerCase().startsWith("timeotp-")) extra.push(k);
				for (const k of e.binaries.keys()) extra.push(`attachment:${k}`);
				const hasTotp = e.fields.has("otp") || [...e.fields.keys()].some((k) => k.toLowerCase().startsWith("timeotp-secret"));
				const id = hexOf(e.uuid).slice(0, 12);
				out.push({
					id, entry: e,
					info: {
						id, title: text(e.fields.get("Title")), group: groupPath, username: text(e.fields.get("UserName")), url: text(e.fields.get("URL")),
						tags, hasTotp, extra,
						confirm: tags.some((t) => t.toLowerCase() === confirmTag) || sameGroup(groupPath, this.cfg.confirmGroups),
					},
				});
			}
			for (const sub of g.groups) walk(sub, [...path, sub.name ?? ""]);
		};
		walk(db.getDefaultGroup(), []);
		return out;
	}

	private startTimer(): void {
		this.stopTimer();
		this.timer = setInterval(() => this.tick(), 5_000);
		this.timer.unref();
	}

	/** Apply the idle/hard-stop limits. Runs on a timer; exposed so tests need not wait for it. */
	tick(): void {
		if (!this.db) return;
		const now = this.now();
		if (now - this.unlockedAt > this.cfg.maxHours * 3_600_000) this.lock("max");
		else if (this.cfg.mode === "session" && now - this.lastUse > this.cfg.idleMinutes * 60_000) this.lock("idle");
	}
	private stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

	lock(reason: "idle" | "max" | "manual" | "replaced" = "manual"): boolean {
		if (!this.db) return false;
		this.db = null;
		this.index = [];
		this.used.clear();
		this.stopTimer();
		try { this.onLocked(reason); } catch { /* notification must never block locking */ }
		return true;
	}

	/** Distinct entries used since the last unlock. */
	get usedEntries(): number { return this.used.size; }

	/** Would using this entry go beyond the per-session budget of distinct entries? */
	overBudget(id: string): boolean { return !this.used.has(id) && this.used.size >= this.cfg.maxEntriesPerSession; }

	/** Record a use. `first` is true the first time this field of this entry is used in this session. */
	noteUse(id: string, field: string): { first: boolean; distinct: number } {
		const f = field.toLowerCase();
		let fields = this.used.get(id);
		if (!fields) { fields = new Set(); this.used.set(id, fields); }
		const first = !fields.has(f);
		fields.add(f);
		return { first, distinct: this.used.size };
	}

	private require(): void {
		if (!this.db) throw new KeepassError("locked", "KeePass is locked");
		this.lastUse = this.now();
	}

	search(query: string, opts: { group?: string; limit?: number } = {}): { total: number; results: EntryInfo[] } {
		this.require();
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		const group = opts.group?.replace(/^\/+|\/+$/g, "").toLowerCase();
		const scored: Array<{ info: EntryInfo; score: number }> = [];
		for (const { info } of this.index) {
			if (group && !(info.group.toLowerCase() === group || info.group.toLowerCase().startsWith(`${group}/`))) continue;
			const title = info.title.toLowerCase();
			const hay = `${title} ${info.username} ${info.url} ${info.group} ${info.tags.join(" ")}`.toLowerCase();
			if (!tokens.every((t) => hay.includes(t))) continue;
			scored.push({ info, score: tokens.filter((t) => title.includes(t)).length });
		}
		scored.sort((a, b) => b.score - a.score || a.info.title.localeCompare(b.info.title));
		// Listing everything is credential discovery; an empty query only ever shows a short page.
		const cap = tokens.length || group ? 50 : 15;
		return { total: scored.length, results: scored.slice(0, Math.max(1, Math.min(opts.limit ?? 15, cap))).map((s) => s.info) };
	}

	/** Entry metadata for a reference, without any secret. Throws not-found for hidden and unknown entries alike. */
	describe(ref: string): { info: EntryInfo; field: string } {
		const { rec, field } = this.locate(ref);
		return { info: rec.info, field };
	}

	private locate(ref: string): { rec: Rec; field: string } {
		this.require();
		const m = KP_REF.exec(ref);
		if (!m) throw new KeepassError("bad-field", `not a KeePass reference: ${ref.slice(0, 40)}`);
		const hits = this.index.filter((r) => r.id.startsWith(m[1]!) || hexOf(r.entry.uuid).startsWith(m[1]!));
		if (hits.length === 0) throw new KeepassError("not-found", "no such KeePass entry (use keepass_search to get a current id)");
		if (hits.length > 1) throw new KeepassError("not-found", "that id prefix matches several entries; use a longer id");
		return { rec: hits[0]!, field: (m[2] ?? "password").trim() };
	}

	/** Produce the secret itself. Only the harness calls this; its result must never be shown to the model. */
	get(ref: string): Resolved {
		const { rec, field } = this.locate(ref);
		const e = rec.entry, info = rec.info, f = field.toLowerCase();
		const need = (value: string, secret: boolean): Resolved => {
			if (!value) throw new KeepassError("bad-field", `field "${field}" of that entry is empty`);
			if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new KeepassError("too-big", `field "${field}" is too large`);
			return { value, info, field, secret };
		};
		if (f === "password") return need(text(e.fields.get("Password")), true);
		if (f === "username") return need(text(e.fields.get("UserName")), false);
		if (f === "url") return need(text(e.fields.get("URL")), false);
		if (f === "totp" || f === "otp") {
			const now = this.now();
			const p = this.totpParams(e);
			return { ...need(totpAt(p, now), true), validForSec: totpRemaining(p, now) };
		}
		if (f.startsWith("attachment:")) {
			const name = field.slice("attachment:".length);
			const bin = e.binaries.get(name);
			const raw = bin && "value" in bin ? bin.value : undefined;
			if (!raw) throw new KeepassError("bad-field", `no attachment named "${name}" on that entry`);
			const bytes = raw instanceof kdbxweb.ProtectedValue ? Buffer.from(raw.getBinary()) : Buffer.from(raw as ArrayBuffer);
			if (bytes.length > MAX_VALUE_BYTES) throw new KeepassError("too-big", "attachment is too large to use as a secret");
			if (bytes.includes(0)) throw new KeepassError("bad-field", "attachment is binary, not text; only text attachments (such as an SSH key) can be used");
			return need(bytes.toString("utf8"), true);
		}
		if (f === "notes" || f === "title") throw new KeepassError("bad-field", `field "${field}" is not available to the agent`);
		for (const [k, v] of e.fields) {
			if (RESERVED.has(k.toLowerCase()) || k.toLowerCase().startsWith("timeotp-")) continue;
			if (k === field || k.toLowerCase() === f) return need(text(v), true);
		}
		throw new KeepassError("bad-field", `that entry has no field "${field}" (available: password, username, url${info.hasTotp ? ", totp" : ""}${info.extra.length ? `, ${info.extra.join(", ")}` : ""})`);
	}

	private totpParams(e: kdbxweb.KdbxEntry): TotpParams {
		try {
			const uri = text(e.fields.get("otp"));
			if (uri) return parseOtpAuth(uri);
			const p = timeOtpParams((name) => { const v = text(e.fields.get(name)); return v || undefined; });
			if (!p) throw new KeepassError("bad-field", "that entry has no TOTP secret");
			return p;
		} catch (err) {
			if (err instanceof TotpError) throw new KeepassError("bad-field", err.message);
			throw err;
		}
	}

	/** Provenance of the installed copy. The hash is always recomputed from the file; a stale sidecar is ignored. */
	meta(): InstallMeta | null {
		let buf: Buffer;
		try { buf = readFileSync(this.cfg.path); } catch { return null; }
		const sha256 = createHash("sha256").update(buf).digest("hex");
		try {
			const m = JSON.parse(readFileSync(`${this.cfg.path}.meta.json`, "utf8")) as Partial<InstallMeta>;
			if (m.sha256 === sha256 && (m.source === "drive" || m.source === "upload") && typeof m.installedAt === "string") return { ...m, sha256 } as InstallMeta;
		} catch { /* no sidecar, or unreadable */ }
		return { source: "upload", sha256, installedAt: new Date(statSync(this.cfg.path).mtimeMs).toISOString() };
	}

	/**
	 * Install a database file (one the operator sent, or one fetched from Drive). Validates the signature, replaces atomically,
	 * keeps one previous generation, records where it came from, and locks (the old in-memory copy is stale and the new file has
	 * not been proven to open yet).
	 */
	installFile(src: string, from: { source: "drive" | "upload"; driveModTime?: string } = { source: "upload" }): { bytes: number; sha256: string } {
		const buf = readFileSync(src);
		if (buf.length > this.cfg.maxFileMb * 1024 * 1024) throw new KeepassError("too-big", `file is larger than ${this.cfg.maxFileMb} MB`);
		if (!looksLikeKdbx(buf)) throw new KeepassError("bad-file", "that is not a KDBX 3/4 database");
		mkdirSync(dirname(this.cfg.path), { recursive: true, mode: 0o700 });
		chmodSync(dirname(this.cfg.path), 0o700);
		const sha256 = createHash("sha256").update(buf).digest("hex");
		const tmp = `${this.cfg.path}.tmp`;
		writeFileSync(tmp, buf, { mode: 0o600 });
		const fd = openSync(tmp, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
		if (existsSync(this.cfg.path)) renameSync(this.cfg.path, `${this.cfg.path}.prev`);
		renameSync(tmp, this.cfg.path);
		chmodSync(this.cfg.path, 0o600);
		const meta: InstallMeta = { source: from.source, sha256, installedAt: new Date(this.now()).toISOString(), ...(from.driveModTime ? { driveModTime: from.driveModTime } : {}) };
		writeFileSync(`${this.cfg.path}.meta.json.tmp`, JSON.stringify(meta), { mode: 0o600 });
		renameSync(`${this.cfg.path}.meta.json.tmp`, `${this.cfg.path}.meta.json`);
		this.lock("replaced");
		return { bytes: buf.length, sha256 };
	}
}
