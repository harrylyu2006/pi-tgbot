/**
 * Encrypted secret store.
 *
 * Each value is sealed with AES-256-GCM under a master key that lives in a
 * *different* file (default /etc/pi-tg/vault.key, 0600) from the ciphertext
 * (default /var/lib/pi-tg/vault/vault.json, 0600). The entry name is bound in as
 * AAD, so ciphertexts cannot be swapped between names.
 *
 * Honest limit: the daemon must decrypt unattended (that is the point — the
 * agent logs in on the operator's behalf without asking each time), so anyone
 * who can read both files as root can read the secrets. What this does buy:
 * values never appear in chat transcripts, session logs, model context, git,
 * backups of the state directory, or a stray `grep`/`cat` of the vault file.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_VALUE_BYTES = 64 * 1024;
/** Values shorter than this are not scrubbed from output (too many false positives). */
export const MIN_SCRUB_LEN = 6;

export interface SecretMeta {
	name: string;
	description: string;
	created: string;
	updated: string;
	lastUsed: string | null;
	uses: number;
	/** Every use must be approved in Telegram. Set by the operator on the input page, never by the model. */
	confirm: boolean;
	length: number;
	scrubbable: boolean;
}

interface StoredEntry {
	description: string;
	created: string;
	updated: string;
	lastUsed: string | null;
	uses: number;
	confirm: boolean;
	length: number;
	iv: string;
	ct: string;
}

interface VaultFile {
	version: 1;
	entries: Record<string, StoredEntry>;
}

export class VaultError extends Error {}

export class Vault {
	private readonly file: string;
	private readonly key: Buffer;
	private data: VaultFile;
	private readonly listeners = new Set<() => void>();

	constructor(dir: string, keyPath: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		this.file = join(dir, "vault.json");
		this.key = Vault.loadKey(keyPath, existsSync(this.file));
		this.data = existsSync(this.file) ? Vault.parse(readFileSync(this.file, "utf8")) : { version: 1, entries: {} };
		// Fail at boot, not at first use, if the key cannot open what is on disk.
		for (const name of Object.keys(this.data.entries)) this.get(name, { touch: false });
	}

	private static loadKey(keyPath: string, vaultExists: boolean): Buffer {
		if (existsSync(keyPath)) {
			const raw = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
			if (raw.length !== 32) throw new VaultError(`vault key ${keyPath} is not 32 bytes of base64`);
			return raw;
		}
		// A missing key next to an existing vault must never silently mint a new one:
		// that would make every stored secret permanently unreadable.
		if (vaultExists) throw new VaultError(`vault exists but key ${keyPath} is missing; restore it from backup`);
		mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
		const key = randomBytes(32);
		writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(keyPath, 0o600);
		return key;
	}

	private static parse(text: string): VaultFile {
		const parsed = JSON.parse(text) as VaultFile;
		if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) throw new VaultError("unrecognised vault file");
		return parsed;
	}

	private aad(name: string): Buffer {
		return Buffer.from(`pi-tg-vault-v1:${name}`, "utf8");
	}

	private persist(notify = true): void {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, 1)}\n`, { mode: 0o600 });
		const fd = openSync(tmp, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(tmp, this.file);
		chmodSync(this.file, 0o600);
		if (notify) for (const fn of this.listeners) fn();
	}

	/** Called after every mutation (used to rebuild the output scrubber). */
	onChange(fn: () => void): void {
		this.listeners.add(fn);
	}

	has(name: string): boolean {
		return Object.hasOwn(this.data.entries, name);
	}

	private meta(name: string, e: StoredEntry): SecretMeta {
		return {
			name, description: e.description, created: e.created, updated: e.updated, lastUsed: e.lastUsed,
			uses: e.uses, confirm: e.confirm, length: e.length, scrubbable: e.length >= MIN_SCRUB_LEN,
		};
	}

	list(): SecretMeta[] {
		return Object.entries(this.data.entries).map(([n, e]) => this.meta(n, e)).sort((a, b) => a.name.localeCompare(b.name));
	}

	getMeta(name: string): SecretMeta | null {
		const e = Object.hasOwn(this.data.entries, name) ? this.data.entries[name] : undefined;
		return e ? this.meta(name, e) : null;
	}

	set(name: string, value: string, opts: { description?: string; confirm?: boolean }): SecretMeta {
		if (!NAME_RE.test(name)) throw new VaultError("invalid secret name");
		if (value.length === 0) throw new VaultError("empty value");
		if (value.includes("\0")) throw new VaultError("value contains NUL");
		if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new VaultError("value too large");
		const now = new Date().toISOString();
		const prev = Object.hasOwn(this.data.entries, name) ? this.data.entries[name] : undefined;
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		cipher.setAAD(this.aad(name));
		const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
		this.data.entries[name] = {
			description: (opts.description ?? prev?.description ?? "").slice(0, 200),
			created: prev?.created ?? now, updated: now, lastUsed: prev?.lastUsed ?? null, uses: prev?.uses ?? 0,
			confirm: opts.confirm ?? prev?.confirm ?? false,
			length: [...value].length, iv: iv.toString("base64"), ct: ct.toString("base64"),
		};
		this.persist();
		return this.meta(name, this.data.entries[name]!);
	}

	get(name: string, opts: { touch?: boolean } = {}): string {
		const e = Object.hasOwn(this.data.entries, name) ? this.data.entries[name] : undefined;
		if (!e) throw new VaultError(`no such secret: ${name}`);
		const raw = Buffer.from(e.ct, "base64");
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "base64"));
		decipher.setAAD(this.aad(name));
		decipher.setAuthTag(raw.subarray(raw.length - 16));
		let value: string;
		try { value = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8"); }
		catch { throw new VaultError(`cannot decrypt secret ${name} (wrong key or tampered file)`); }
		if (opts.touch) {
			e.lastUsed = new Date().toISOString();
			e.uses += 1;
			this.persist(false); // usage counters do not change any value, so the scrubber need not rebuild
		}
		return value;
	}

	delete(name: string): boolean {
		if (!this.has(name)) return false;
		delete this.data.entries[name];
		this.persist();
		return true;
	}

	/** Every plaintext, for building the output scrubber. Never log or return this. */
	allValues(): Array<{ name: string; value: string }> {
		return Object.keys(this.data.entries).map((name) => ({ name, value: this.get(name, { touch: false }) }));
	}
}
