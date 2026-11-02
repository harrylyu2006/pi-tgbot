#!/usr/bin/env node
/**
 * Read-only Google Drive authorization for rclone on a machine without a browser (optional helper for `secrets.keepass.sync`).
 *
 * Google no longer offers the out-of-band flow and the device-code flow does not support `drive.readonly`, so this uses the
 * loopback flow with a manual hand-over: you open the link on your phone, approve, the browser lands on an unreachable
 * http://127.0.0.1:53682/?code=… page, and you give this tool that whole address.
 *
 *   node scripts/gdrive-oauth.ts start                      # prints the consent URL
 *   REDIR='<pasted address>' node scripts/gdrive-oauth.ts finish   # exchanges the code, writes the rclone remote
 *
 * Environment (all optional):
 *   GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET   your own OAuth client ("Desktop app"); otherwise copied from an existing rclone remote
 *   GDRIVE_OAUTH_CLIENT_REMOTE                rclone remote to copy client_id/client_secret from (default: gdrive)
 *   GDRIVE_OAUTH_REMOTE                       name of the remote to create (default: gdrive-ro)
 *   RCLONE_CONFIG                             rclone.conf location (default: `rclone config file`)
 *
 * Nothing secret is ever printed: not the code, not the tokens. The only accepted outcome is exactly the `drive.readonly` scope.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const REDIRECT = "http://127.0.0.1:53682/";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const MAX_AGE_MS = 30 * 60_000;

export class OAuthError extends Error {}

export interface Client { id: string; secret: string }
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const b64url = (b: Buffer): string => b.toString("base64url");

/** Step 1: remember a PKCE verifier and a random state (0600), return the consent URL. */
export function startAuth(client: Client, stateFile: string, now = Date.now()): string {
	const verifier = b64url(randomBytes(48));
	const state = b64url(randomBytes(24));
	mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
	writeFileSync(stateFile, JSON.stringify({ verifier, state, created: now }), { mode: 0o600 });
	chmodSync(stateFile, 0o600);
	const q = new URLSearchParams({
		client_id: client.id, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, state, access_type: "offline", prompt: "consent",
		code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
	});
	return `${AUTH_ENDPOINT}?${q}`;
}

export interface FinishOptions {
	redir: string;
	client: Client;
	stateFile: string;
	confPath: string;
	remote: string;
	fetchFn?: FetchFn;
	now?: number;
}

/** Remove `[name]` (and its keys) from an rclone.conf, leaving every other byte alone. */
export function withoutSection(conf: string, name: string): string {
	const out: string[] = [];
	let skip = false;
	for (const line of conf.split("\n")) {
		if (/^\s*\[.*\]\s*$/.test(line)) skip = line.trim() === `[${name}]`;
		if (!skip) out.push(line);
	}
	const text = out.join("\n").replace(/\n+$/, "");
	return text ? `${text}\n` : "";
}

/** Step 2: exchange the pasted address for tokens and write the rclone remote. Returns a one-line, secret-free summary. */
export async function finishAuth(o: FinishOptions): Promise<string> {
	const now = o.now ?? Date.now();
	const fetchFn: FetchFn = o.fetchFn ?? ((url, init) => fetch(url, init));
	const redir = o.redir.trim();
	if (!redir) throw new OAuthError("the pasted address is empty");
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.@+-]*$/.test(o.remote)) throw new OAuthError("invalid remote name");
	let pending: { verifier: string; state: string; created: number };
	try { pending = JSON.parse(readFileSync(o.stateFile, "utf8")); } catch { throw new OAuthError("no pending authorization (run `start` first)"); }
	if (now - pending.created > MAX_AGE_MS) throw new OAuthError("the authorization link is older than 30 minutes; run `start` again");
	let url: URL;
	try { url = new URL(redir); } catch { throw new OAuthError("that is not an address; paste the whole address-bar URL that starts with http://127.0.0.1:53682/"); }
	if (url.searchParams.get("error")) throw new OAuthError(`Google reported: ${url.searchParams.get("error")}`);
	if (url.searchParams.get("state") !== pending.state) throw new OAuthError("state does not match this authorization attempt (wrong or old address)");
	const code = url.searchParams.get("code");
	if (!code) throw new OAuthError("no code in the pasted address; paste the whole address-bar URL that starts with http://127.0.0.1:53682/");

	const res = await fetchFn(TOKEN_ENDPOINT, {
		method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: o.client.id, client_secret: o.client.secret, redirect_uri: REDIRECT, code_verifier: pending.verifier }).toString(),
	});
	const tok = await res.json().catch(() => ({}));
	if (!res.ok) throw new OAuthError(`token exchange failed: ${typeof tok.error === "string" ? tok.error : `HTTP ${res.status}`}`);
	if (!tok.refresh_token || !tok.access_token) throw new OAuthError("Google returned no refresh token (run `start` again; prompt=consent is already set)");
	const granted = new Set(String(tok.scope ?? "").split(/\s+/).filter(Boolean));
	if (granted.size !== 1 || !granted.has(SCOPE)) throw new OAuthError(`granted scope is not exactly drive.readonly: ${[...granted].join(" ") || "(none)"}`);

	const expiry = new Date(now + Number(tok.expires_in ?? 3600) * 1000).toISOString().replace("Z", "000000Z");
	const token = JSON.stringify({ access_token: tok.access_token, token_type: "Bearer", refresh_token: tok.refresh_token, expiry });
	const old = existsSync(o.confPath) ? readFileSync(o.confPath, "utf8") : "";
	let backup = "";
	if (old) { backup = `${o.confPath}.bak.${new Date(now).toISOString().replace(/\D/g, "").slice(0, 14)}`; writeFileSync(backup, old, { mode: 0o600 }); chmodSync(backup, 0o600); }
	const section = [`[${o.remote}]`, "type = drive", `client_id = ${o.client.id}`, `client_secret = ${o.client.secret}`, "scope = drive.readonly", `token = ${token}`, "root_folder_id = "].join("\n");
	const base = withoutSection(old, o.remote);
	const next = `${base}${base ? "\n" : ""}${section}\n`; // `base` is empty or ends with exactly one newline
	mkdirSync(dirname(o.confPath), { recursive: true });
	const tmp = `${o.confPath}.tmp`;
	writeFileSync(tmp, next, { mode: 0o600 });
	renameSync(tmp, o.confPath);
	chmodSync(o.confPath, 0o600);
	rmSync(o.stateFile, { force: true });
	return `authorized: remote [${o.remote}] written (scope drive.readonly, refresh token received${backup ? ", backup of rclone.conf kept" : ""})`;
}

// ---- CLI -------------------------------------------------------------------------------------------------------------

function rcloneKv(args: string[]): Record<string, string> {
	const r = spawnSync("rclone", args, { encoding: "utf8" });
	if (r.error || r.status !== 0) throw new OAuthError(`could not run rclone ${args.join(" ")}`);
	return Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes(" = ")).map((l) => { const i = l.indexOf(" = "); return [l.slice(0, i), l.slice(i + 3)]; }));
}

function resolveClient(env: NodeJS.ProcessEnv): Client {
	if (env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET) return { id: env.GDRIVE_CLIENT_ID, secret: env.GDRIVE_CLIENT_SECRET };
	const name = env.GDRIVE_OAUTH_CLIENT_REMOTE ?? "gdrive";
	const kv = rcloneKv(["config", "show", name]);
	if (!kv.client_id || !kv.client_secret) throw new OAuthError(`rclone remote "${name}" has no client_id/client_secret; set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET (a Google "Desktop app" OAuth client)`);
	return { id: kv.client_id, secret: kv.client_secret };
}

function rcloneConfPath(env: NodeJS.ProcessEnv): string {
	if (env.RCLONE_CONFIG) return env.RCLONE_CONFIG;
	const r = spawnSync("rclone", ["config", "file"], { encoding: "utf8" });
	const line = r.stdout?.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
	return r.status === 0 && line?.startsWith("/") ? line : join(homedir(), ".config", "rclone", "rclone.conf");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const cmd = process.argv[2];
	const stateFile = join(process.env.GDRIVE_OAUTH_STATE_DIR ?? join(homedir(), ".config", "pitg-gdrive-oauth"), "pending.json");
	try {
		if (cmd === "start") console.log(startAuth(resolveClient(process.env), stateFile));
		else if (cmd === "finish") console.log(await finishAuth({ redir: process.env.REDIR ?? "", client: resolveClient(process.env), stateFile, confPath: rcloneConfPath(process.env), remote: process.env.GDRIVE_OAUTH_REMOTE ?? "gdrive-ro" }));
		else { console.error("usage: node scripts/gdrive-oauth.ts start | REDIR='<pasted address>' node scripts/gdrive-oauth.ts finish"); process.exit(2); }
	} catch (err) {
		console.error(err instanceof OAuthError ? `error: ${err.message}` : "error: unexpected failure");
		process.exit(1);
	}
}
