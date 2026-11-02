/**
 * KeePass types and the few helpers that do not need a KDBX parser. Everything here is dependency-free so that the rest of the
 * secrets plugin (and `config.ts`) can refer to KeePass without loading `kdbxweb`; only `keepass.ts` imports that library, and
 * it is loaded on demand when `secrets.keepass` is configured.
 */

export interface KeepassConfig {
	path: string;
	/** "session": operator unlocks with a one-time page, master password kept in memory only. "stored": master password is a vault secret. */
	mode: "session" | "stored";
	storedSecret: string;
	idleMinutes: number;
	maxHours: number;
	hiddenTag: string;
	confirmTag: string;
	hiddenGroups: string[];
	confirmGroups: string[];
	maxFileMb: number;
	/** Refuse databases whose Argon2 memory cost exceeds this (the service runs under a cgroup memory cap; an OOM kill would restart the whole bot). */
	maxArgonMiB: number;
	/** After this many distinct entries have been used in one unlock session, every further new entry needs the operator's tap. */
	maxEntriesPerSession: number;
	/** Fetch the database from Drive (via rclone) each time the operator unlocks. Absent: only files sent to the bot are used. */
	sync?: { remote: string; timeoutSeconds: number };
}

export type KeepassErrorCode = "locked" | "wrong-password" | "no-file" | "bad-file" | "not-found" | "bad-field" | "unsupported" | "too-big";
export class KeepassError extends Error {
	readonly code: KeepassErrorCode;
	constructor(code: KeepassErrorCode, message: string) { super(message); this.code = code; }
}

export interface EntryInfo {
	id: string;
	title: string;
	group: string;
	username: string;
	url: string;
	tags: string[];
	hasTotp: boolean;
	confirm: boolean;
	/** Names of custom fields and attachments the agent may reference (never their values). */
	extra: string[];
}

export interface Resolved {
	value: string;
	info: EntryInfo;
	field: string;
	/** Whether the value is secret (and therefore must be scrubbed from output). */
	secret: boolean;
	/** Short-lived value (TOTP): seconds it stays valid. */
	validForSec?: number;
}

/** Where the local database copy came from, so a sync never replaces something newer with something older. */
export interface InstallMeta {
	source: "drive" | "upload";
	sha256: string;
	installedAt: string;
	driveModTime?: string;
}

export const KP_REF = /^kp:([0-9a-f]{8,32})(?:#(.{1,80}))?$/;

const KDBX_SIG = Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]);

export function looksLikeKdbx(buf: Buffer): boolean {
	return buf.length > 12 && buf.subarray(0, 8).equals(KDBX_SIG);
}
