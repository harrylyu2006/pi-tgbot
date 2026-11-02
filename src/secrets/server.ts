/**
 * One-time secret input links.
 *
 * Threat model, in order of how likely it is to matter:
 *  1. The value must never enter Telegram history or the model's context →
 *     it travels browser → this server only, sealed in a per-link envelope.
 *  2. A leaked/forwarded link must be near-useless → 256-bit token, single use,
 *     short TTL, write-only (the page can never read anything back), and the
 *     chat message that carried it is edited afterwards to drop the URL.
 *  3. A crawler or Telegram's link previewer must not burn the link → GET never
 *     consumes; only a successful decrypt-and-store does.
 *  4. Web-style attacks on a tiny public surface → loopback bind, Host and
 *     Origin pinning, strict CSP with nonces, no cookies, size limits,
 *     per-IP rate limiting, uniform 404 for anything unknown.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../log.ts";
import { errFields } from "../log.ts";
import { type LinkKey, newLinkKey, openEnvelope, b64u, type Envelope } from "./envelope.ts";
import { renderGone, renderPage } from "./page.ts";
import { MIN_SCRUB_LEN, type SecretMeta, type Vault } from "./vault.ts";

export type LinkOutcome =
	| { status: "saved"; meta: SecretMeta }
	/** The value went to a custom sink (KeePass unlock) rather than the vault. */
	| { status: "done"; detail: string }
	| { status: "expired" }
	| { status: "cancelled" };

/** Thrown by a sink to say "this value was not accepted, the operator may try again" (wrong master password). */
export class LinkRejected extends Error {}

/** What a link does with the decrypted value. Absent means: store it in the vault under `name`. */
export type LinkSink = (value: string) => Promise<{ detail: string; length: number }>;

export interface LinkHandle {
	url: string;
	expiresAt: number;
	done: Promise<LinkOutcome>;
	cancel(): void;
}

interface Pending {
	name: string;
	description: string;
	replacing: boolean;
	kind: "secret" | "unlock";
	sink?: LinkSink;
	/** Guards against two concurrent POSTs racing the same single-use link. */
	busy: boolean;
	key: LinkKey;
	expiresAt: number;
	failures: number;
	settle: (o: LinkOutcome) => void;
}

export interface LinkServerOptions {
	host: string;
	port: number;
	/** Public origin the operator opens, e.g. https://vault.example.com — pins Host and Origin. */
	baseUrl: string;
	/** Extra Host header values to accept (tests, direct loopback). */
	extraHosts?: string[];
	vault: Vault;
	log: Logger;
	maxBodyBytes?: number;
	/** Requests per client per minute (unknown tokens count 5x). */
	rateLimitPerMin?: number;
}

const MAX_FAILURES = 5;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class LinkServer {
	private readonly opts: LinkServerOptions;
	private readonly origin: string;
	private readonly hosts: Set<string>;
	private readonly pending = new Map<string, Pending>();
	private readonly hits = new Map<string, { count: number; reset: number }>();
	private server: Server | null = null;
	private sweeper: NodeJS.Timeout | null = null;

	constructor(opts: LinkServerOptions) {
		this.opts = opts;
		const u = new URL(opts.baseUrl);
		this.origin = u.origin;
		this.hosts = new Set([u.host, ...(opts.extraHosts ?? [])].map((h) => h.toLowerCase()));
	}

	get listeningPort(): number {
		const a = this.server?.address();
		return a && typeof a === "object" ? a.port : this.opts.port;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => { void this.handle(req, res).catch((err) => {
			this.opts.log.warn({ msg: "secret link handler error", ...errFields(err) });
			if (!res.headersSent) this.plain(res, 500, "error"); else res.end();
		}); });
		this.server.headersTimeout = 10_000;
		this.server.requestTimeout = 15_000;
		this.server.maxHeadersCount = 40;
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.opts.port, this.opts.host, () => { this.server!.off("error", reject); resolve(); });
		});
		this.sweeper = setInterval(() => this.sweep(), 5_000);
		this.sweeper.unref();
	}

	async stop(): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		for (const [token, p] of this.pending) { this.pending.delete(token); p.settle({ status: "cancelled" }); }
		await new Promise<void>((resolve) => { if (!this.server) resolve(); else { this.server.close(() => resolve()); this.server.closeAllConnections(); } });
	}

	async createLink(input: { name: string; description: string; ttlMs: number; sink?: LinkSink }): Promise<LinkHandle> {
		const token = randomBytes(32).toString("base64url");
		const key = await newLinkKey();
		const expiresAt = Date.now() + input.ttlMs;
		let settle!: (o: LinkOutcome) => void;
		const done = new Promise<LinkOutcome>((resolve) => { settle = resolve; });
		this.pending.set(token, {
			name: input.name, description: input.description, replacing: this.opts.vault.has(input.name),
			kind: input.sink ? "unlock" : "secret", sink: input.sink, busy: false,
			key, expiresAt, failures: 0, settle,
		});
		return {
			url: `${this.origin}/s/${token}`, expiresAt, done,
			cancel: () => { const p = this.pending.get(token); if (p) { this.pending.delete(token); p.settle({ status: "cancelled" }); } },
		};
	}

	private sweep(): void {
		const now = Date.now();
		for (const [token, p] of this.pending) if (p.expiresAt <= now) { this.pending.delete(token); p.settle({ status: "expired" }); }
		for (const [ip, h] of this.hits) if (h.reset <= now) this.hits.delete(ip);
	}

	private find(token: string): Pending | undefined {
		if (!TOKEN_RE.test(token)) return undefined;
		const p = this.pending.get(token);
		if (!p) return undefined;
		if (p.expiresAt <= Date.now()) { this.pending.delete(token); p.settle({ status: "expired" }); return undefined; }
		return p;
	}

	private clientIp(req: IncomingMessage): string {
		const remote = req.socket.remoteAddress ?? "?";
		// Only trust the proxy's header when the peer is the local reverse proxy.
		if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
			const xf = req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"];
			const v = Array.isArray(xf) ? xf[0] : xf;
			if (v) return v.split(",")[0]!.trim().slice(0, 64);
		}
		return remote;
	}

	private limited(ip: string, cost: number): boolean {
		const now = Date.now();
		const h = this.hits.get(ip);
		if (!h || h.reset <= now) { this.hits.set(ip, { count: cost, reset: now + 60_000 }); return false; }
		h.count += cost;
		return h.count > (this.opts.rateLimitPerMin ?? 30);
	}

	private baseHeaders(res: ServerResponse, nonce?: string): void {
		res.setHeader("Cache-Control", "no-store, max-age=0");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("X-Robots-Tag", "noindex, nofollow");
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
		res.setHeader("Content-Security-Policy",
			`default-src 'none'; script-src 'nonce-${nonce ?? "-"}'; style-src 'nonce-${nonce ?? "-"}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
	}

	private plain(res: ServerResponse, status: number, body: string): void {
		this.baseHeaders(res);
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
		res.end(body);
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		this.baseHeaders(res);
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}

	private gone(res: ServerResponse): void {
		const nonce = randomBytes(16).toString("base64url");
		this.baseHeaders(res, nonce);
		res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
		res.end(renderGone(nonce));
	}

	private async readBody(req: IncomingMessage): Promise<Buffer | null> {
		const max = this.opts.maxBodyBytes ?? 160 * 1024;
		const declared = Number(req.headers["content-length"] ?? "0");
		if (Number.isFinite(declared) && declared > max) return null;
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > max) return null;
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = String(req.headers.host ?? "").toLowerCase();
		if (!this.hosts.has(host)) { this.plain(res, 421, "misdirected"); return; }
		const url = new URL(req.url ?? "/", this.origin);
		const m = /^\/s\/([^/]+)$/.exec(url.pathname);
		if (!m) { this.gone(res); return; }
		const token = m[1]!;
		const ip = this.clientIp(req);
		const entry = this.find(token);
		// Unknown tokens cost more: a scanner burns its budget quickly, the operator never notices.
		if (this.limited(ip, entry ? 1 : 5)) { this.plain(res, 429, "slow down"); return; }
		if (!entry) { this.gone(res); return; }

		if (req.method === "GET" || req.method === "HEAD") {
			const nonce = randomBytes(16).toString("base64url");
			this.baseHeaders(res, nonce);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(req.method === "HEAD" ? undefined : renderPage({
				name: entry.name, description: entry.description, token, replacing: entry.replacing,
				publicKeyB64u: b64u.enc(entry.key.publicRaw), expiresAt: entry.expiresAt, nonce, kind: entry.kind,
			}));
			return;
		}
		if (req.method !== "POST") { this.plain(res, 405, "method not allowed"); return; }
		if (req.headers.origin !== this.origin && !(req.headers.origin && this.hosts.has(new URL(req.headers.origin).host))) {
			this.json(res, 403, { ok: false, error: "bad origin" }); return;
		}
		if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			this.json(res, 415, { ok: false, error: "bad content type" }); return;
		}
		const raw = await this.readBody(req);
		if (!raw) { this.json(res, 413, { ok: false, error: "too large" }); return; }
		let env: Envelope;
		try {
			const j = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			if (typeof j.epk !== "string" || typeof j.iv !== "string" || typeof j.ct !== "string") throw new Error("shape");
			env = { epk: j.epk, iv: j.iv, ct: j.ct };
		} catch { this.json(res, 400, { ok: false, error: "malformed" }); return; }

		if (entry.busy) { this.json(res, 409, { ok: false, error: "already being processed" }); return; }
		entry.busy = true;
		try {
			let value: string, confirm: boolean;
			try {
				const body = JSON.parse(await openEnvelope(entry.key, token, env)) as { v?: unknown; c?: unknown };
				if (typeof body.v !== "string" || body.v.length === 0) throw new Error("empty");
				value = body.v;
				confirm = body.c === true;
			} catch {
				// Wrong key, tampering, or garbage. A few tries for flaky clients, then burn the link.
				if (++entry.failures >= MAX_FAILURES) { this.pending.delete(token); entry.settle({ status: "cancelled" }); }
				this.json(res, 400, { ok: false, error: "could not decrypt; reload the page" });
				return;
			}

			if (entry.sink) {
				let r: { detail: string; length: number };
				try { r = await entry.sink(value); }
				catch (err) {
					if (err instanceof LinkRejected) {
						// A wrong guess counts like any other failure: five and the link is gone.
						if (++entry.failures >= MAX_FAILURES) { this.pending.delete(token); entry.settle({ status: "cancelled" }); }
						this.json(res, 422, { ok: false, retry: entry.failures < MAX_FAILURES, error: err.message });
						return;
					}
					this.opts.log.warn({ msg: "link sink failed", ...errFields(err) });
					this.json(res, 500, { ok: false, error: "server error; see the pi-tg journal" });
					return;
				}
				this.pending.delete(token); // single use
				entry.settle({ status: "done", detail: r.detail });
				this.json(res, 200, { ok: true, length: r.length, detail: r.detail });
				return;
			}

			let meta: SecretMeta;
			try {
				meta = this.opts.vault.set(entry.name, value, { description: entry.description, confirm });
			} catch (err) {
				this.opts.log.warn({ msg: "vault rejected secret", ...errFields(err) });
				this.json(res, 422, { ok: false, error: err instanceof Error ? err.message : "rejected" });
				return;
			}
			this.pending.delete(token); // single use
			this.opts.log.info({ msg: "secret stored via link", name: entry.name, length: meta.length });
			entry.settle({ status: "saved", meta });
			this.json(res, 200, {
				ok: true, length: meta.length,
				...(meta.scrubbable ? {} : { warn: `太短（<${MIN_SCRUB_LEN} 字符）：仍可使用，但无法从输出里自动擦除。` }),
			});
		} finally {
			entry.busy = false;
		}
	}
}
