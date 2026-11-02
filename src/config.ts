/**
 * Configuration loading and validation.
 *
 * Unknown keys are a hard error. This is deliberate: `tools.deny` is a safety
 * control, and a typo like `tools.denied` would silently leave bash enabled
 * while looking configured. Failing loudly at boot beats discovering it later.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Level } from "./log.ts";
import type { SecretsConfig } from "./secrets/service.ts";
import { REMOTE_RE } from "./secrets/remote.ts";

export interface RenderConfig {
	/** Minimum ms between editMessageText calls for one message id. */
	editThrottleMs: number;
	/** Target body size. Below 4096 because HTML entity expansion inflates it. */
	maxChars: number;
	/**
	 * Soft ceiling for routine churn. Meaningful answer/thinking changes may still
	 * edit after this point so a long live turn never looks frozen.
	 */
	maxEditsPerTurn: number;
	/** Turns longer than this deliver the answer as a new message, so Telegram notifies. */
	notifyAfterMs: number;
}

export interface Config {
	botToken: string;
	allowedUserId: number;
	/** Working directory for the agent. Fixed, single-session by design. */
	cwd: string;
	agentDir: string;
	/** Dedicated session dir — must NOT be the default, or we fight the operator's interactive pi. */
	sessionDir: string;
	/**
	 * Optional "provider/id" override. Absent means "use settings.json".
	 * Kept daemon-local on purpose: trying a model here must not change which
	 * model the operator's interactive pi starts with.
	 */
	model?: string;
	logLevel: Level;
	render: RenderConfig;
	tools: {
		/** Empty by default. One edit here disables a tool without touching code. */
		deny: string[];
		/** Registered-but-inactive built-ins worth turning on. */
		extraActive: string[];
	};
	turn: {
		/** Abort only after this long with no request or agent progress event. */
		idleTimeoutMs: number;
	};
	/** Durable state (seen update ids, interrupted-turn marker). */
	statePath: string;
	/** Append-only tool metadata audit log; never stores raw args or results. */
	auditPath: string;
	/**
	 * Extra pi extension paths to load.
	 *
	 * The daemon runs with `noExtensions: true`, so anything dropped into
	 * ~/.pi/agent/extensions is deliberately ignored — that directory is the
	 * operator's interactive setup and must not silently gain code in a root
	 * daemon. Extensions used here are listed explicitly and vendored locally.
	 */
	extensions: string[];
	files: {
		inboxDir: string;
		/** Directories `telegram_send_file` may read from. Nothing else is sendable. */
		outboxRoots: string[];
		maxDownloadMb: number;
		maxUploadMb: number;
		retentionDays: number;
	};
	/**
	 * Encrypted secret input + vault (optional). Absent means the feature is off:
	 * no listener, no tools, no hooks.
	 */
	secrets?: SecretsConfig;
	coldStart: {
		/**
		 * Messages older than this on startup are acknowledged and skipped.
		 * Replaying a backlog of prompts as root is the worst failure mode
		 * available here, so the default errs strongly toward skipping.
		 */
		staleSeconds: number;
	};
}

const DEFAULT_HOME = process.env.HOME ?? process.cwd();

const DEFAULTS = {
	cwd: process.cwd(),
	agentDir: `${DEFAULT_HOME}/.pi/agent`,
	sessionDir: "/var/lib/pi-tg/sessions",
	logLevel: "info" as Level,
	render: { editThrottleMs: 2500, maxChars: 3800, maxEditsPerTurn: 600, notifyAfterMs: 30_000 },
	tools: { deny: [] as string[], extraActive: ["grep", "find", "ls"] },
	turn: { idleTimeoutMs: 20 * 60 * 1000 },
	statePath: "/var/lib/pi-tg/state.json",
	auditPath: "/var/log/pi-tg/audit.jsonl",
	extensions: [] as string[],
	coldStart: { staleSeconds: 900 },
	files: {
		inboxDir: "/var/lib/pi-tg/inbox",
		outboxRoots: [process.cwd(), "/tmp/pi-tg", "/var/lib/pi-tg"],
		maxDownloadMb: 20, // Bot API's own download ceiling
		maxUploadMb: 50,
		retentionDays: 14,
	},
};

/** Tools whose arguments leave the box or land on disk; `{{secret:NAME}}` is refused there by default. */
const DEFAULT_DENY_PLACEHOLDER_TOOLS = [
	"write", "edit", "email_send", "email_reply", "email_forward", "telegram_ask", "telegram_send_file",
	"brave_search", "brave_source_check", "brave_fetch", "brave_get_content",
	"muse_generate_image", "muse_generate_video", "muse_media_status",
];

class ConfigError extends Error {}

function requireKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) {
			throw new ConfigError(`unknown config key ${path}${key} (allowed: ${allowed.join(", ")})`);
		}
	}
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function num(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ConfigError(`${path} must be a finite number`);
	return value;
}

function strArray(value: unknown, fallback: string[], path: string): string[] {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
		throw new ConfigError(`${path} must be an array of non-empty strings`);
	}
	return [...value] as string[];
}

function absolutePath(value: unknown, fallback: string, path: string): string {
	const result = value === undefined ? fallback : value;
	if (typeof result !== "string" || result.trim().length === 0 || !isAbsolute(result)) {
		throw new ConfigError(`${path} must be a non-empty absolute path`);
	}
	return resolve(result);
}

function integerAtLeast(value: number, min: number, path: string): void {
	if (!Number.isInteger(value) || value < min) throw new ConfigError(`${path} must be an integer >= ${min}`);
}

export function loadConfig(path: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new ConfigError(`cannot read config ${path}: ${String(err)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config must be a JSON object");
	const o = raw as Record<string, unknown>;

	requireKeys(
		o,
		[
			"botToken", "allowedUserId", "cwd", "agentDir", "sessionDir", "model", "logLevel",
			"render", "tools", "turn", "statePath", "auditPath", "coldStart", "files", "extensions", "secrets",
		],
		"",
	);

	if (typeof o.botToken !== "string" || !/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(o.botToken)) {
		throw new ConfigError("botToken missing or not in <id>:<secret> form");
	}
	if (typeof o.allowedUserId !== "number" || !Number.isSafeInteger(o.allowedUserId) || o.allowedUserId <= 0) {
		throw new ConfigError("allowedUserId must be a positive safe integer Telegram user id");
	}
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) !== 0) throw new ConfigError(`config file ${path} must not be accessible by group or others`);
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`cannot stat config ${path}: ${String(err)}`);
	}

	const renderRaw = object(o.render, "render");
	requireKeys(renderRaw, ["editThrottleMs", "maxChars", "maxEditsPerTurn", "notifyAfterMs"], "render.");
	const toolsRaw = object(o.tools, "tools");
	requireKeys(toolsRaw, ["deny", "extraActive"], "tools.");
	const turnRaw = object(o.turn, "turn");
	requireKeys(turnRaw, ["idleTimeoutMs"], "turn.");
	const coldStartRaw = object(o.coldStart, "coldStart");
	requireKeys(coldStartRaw, ["staleSeconds"], "coldStart.");
	const filesRaw = object(o.files, "files");
	requireKeys(filesRaw, ["inboxDir", "outboxRoots", "maxDownloadMb", "maxUploadMb", "retentionDays"], "files.");

	const cfg: Config = {
		botToken: o.botToken,
		allowedUserId: o.allowedUserId,
		cwd: absolutePath(o.cwd, DEFAULTS.cwd, "cwd"),
		agentDir: absolutePath(o.agentDir, DEFAULTS.agentDir, "agentDir"),
		sessionDir: absolutePath(o.sessionDir, DEFAULTS.sessionDir, "sessionDir"),
		logLevel: (typeof o.logLevel === "string" ? o.logLevel : DEFAULTS.logLevel) as Level,
		render: {
			editThrottleMs: num(renderRaw.editThrottleMs, DEFAULTS.render.editThrottleMs, "render.editThrottleMs"),
			maxChars: num(renderRaw.maxChars, DEFAULTS.render.maxChars, "render.maxChars"),
			maxEditsPerTurn: num(renderRaw.maxEditsPerTurn, DEFAULTS.render.maxEditsPerTurn, "render.maxEditsPerTurn"),
			notifyAfterMs: num(renderRaw.notifyAfterMs, DEFAULTS.render.notifyAfterMs, "render.notifyAfterMs"),
		},
		tools: {
			deny: strArray(toolsRaw.deny, DEFAULTS.tools.deny, "tools.deny"),
			extraActive: strArray(toolsRaw.extraActive, DEFAULTS.tools.extraActive, "tools.extraActive"),
		},
		turn: { idleTimeoutMs: num(turnRaw.idleTimeoutMs, DEFAULTS.turn.idleTimeoutMs, "turn.idleTimeoutMs") },
		statePath: absolutePath(o.statePath, DEFAULTS.statePath, "statePath"),
		auditPath: absolutePath(o.auditPath, DEFAULTS.auditPath, "auditPath"),
		extensions: strArray(o.extensions, DEFAULTS.extensions, "extensions"),
		coldStart: {
			staleSeconds: num(coldStartRaw.staleSeconds, DEFAULTS.coldStart.staleSeconds, "coldStart.staleSeconds"),
		},
		files: {
			inboxDir: absolutePath(filesRaw.inboxDir, DEFAULTS.files.inboxDir, "files.inboxDir"),
			outboxRoots: strArray(filesRaw.outboxRoots, DEFAULTS.files.outboxRoots, "files.outboxRoots").map((path, index) =>
				absolutePath(path, path, `files.outboxRoots[${index}]`),
			),
			maxDownloadMb: num(filesRaw.maxDownloadMb, DEFAULTS.files.maxDownloadMb, "files.maxDownloadMb"),
			maxUploadMb: num(filesRaw.maxUploadMb, DEFAULTS.files.maxUploadMb, "files.maxUploadMb"),
			retentionDays: num(filesRaw.retentionDays, DEFAULTS.files.retentionDays, "files.retentionDays"),
		},
	};

	if (o.secrets !== undefined) {
		const sr = object(o.secrets, "secrets");
		requireKeys(sr, ["baseUrl", "listenHost", "listenPort", "dir", "keyPath", "linkTtlSeconds", "denyPlaceholderTools", "keepass"], "secrets.");
		let base: URL;
		try { base = new URL(String(sr.baseUrl)); } catch { throw new ConfigError("secrets.baseUrl must be a URL such as https://vault.example.com"); }
		const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
		if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
			throw new ConfigError("secrets.baseUrl must be https:// (http only for localhost testing)");
		}
		if (base.pathname !== "/" || base.search || base.hash) throw new ConfigError("secrets.baseUrl must be an origin without a path");
		const host = typeof sr.listenHost === "string" ? sr.listenHost : "127.0.0.1";
		if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
			throw new ConfigError("secrets.listenHost must be loopback; put a TLS reverse proxy in front of it");
		}
		const port = num(sr.listenPort, 18620, "secrets.listenPort");
		integerAtLeast(port, 1, "secrets.listenPort");
		const ttl = num(sr.linkTtlSeconds, 600, "secrets.linkTtlSeconds");
		if (!Number.isInteger(ttl) || ttl < 60 || ttl > 1800) throw new ConfigError("secrets.linkTtlSeconds must be between 60 and 1800");
		cfg.secrets = {
			baseUrl: base.origin, host, port,
			dir: absolutePath(sr.dir, "/var/lib/pi-tg/vault", "secrets.dir"),
			keyPath: absolutePath(sr.keyPath, "/etc/pi-tg/vault.key", "secrets.keyPath"),
			linkTtlSeconds: ttl,
			denyPlaceholderTools: strArray(sr.denyPlaceholderTools, DEFAULT_DENY_PLACEHOLDER_TOOLS, "secrets.denyPlaceholderTools"),
			auditPath: join(dirname(cfg.auditPath), "secrets-audit.jsonl"),
		};
		if (sr.keepass !== undefined) {
			const kr = object(sr.keepass, "secrets.keepass");
			requireKeys(kr, ["path", "mode", "storedSecret", "idleMinutes", "maxHours", "hiddenTag", "confirmTag", "hiddenGroups", "confirmGroups", "maxFileMb", "maxArgonMiB", "maxEntriesPerSession", "sync"], "secrets.keepass.");
			const mode = kr.mode === undefined ? "session" : kr.mode;
			if (mode !== "session" && mode !== "stored") throw new ConfigError('secrets.keepass.mode must be "session" or "stored"');
			const idle = num(kr.idleMinutes, 30, "secrets.keepass.idleMinutes"), maxH = num(kr.maxHours, 8, "secrets.keepass.maxHours");
			if (!Number.isInteger(idle) || idle < 1 || idle > 1440) throw new ConfigError("secrets.keepass.idleMinutes must be 1-1440");
			if (!Number.isInteger(maxH) || maxH < 1 || maxH > 72) throw new ConfigError("secrets.keepass.maxHours must be 1-72");
			const tag = (v: unknown, fallback: string, path: string): string => {
				const t = v === undefined ? fallback : v;
				if (typeof t !== "string" || !/^[^,;\s]{1,40}$/.test(t)) throw new ConfigError(`${path} must be a single tag without spaces, commas or semicolons`);
				return t;
			};
			const stored = kr.storedSecret === undefined ? "keepass-master" : kr.storedSecret;
			if (typeof stored !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(stored)) throw new ConfigError("secrets.keepass.storedSecret must be a valid secret name");
			const maxMb = num(kr.maxFileMb, 64, "secrets.keepass.maxFileMb");
			if (!(maxMb > 0 && maxMb <= 256)) throw new ConfigError("secrets.keepass.maxFileMb must be in (0, 256]");
			const argon = num(kr.maxArgonMiB, 256, "secrets.keepass.maxArgonMiB");
			if (!Number.isInteger(argon) || argon < 16 || argon > 2048) throw new ConfigError("secrets.keepass.maxArgonMiB must be 16-2048");
			const budget = num(kr.maxEntriesPerSession, 8, "secrets.keepass.maxEntriesPerSession");
			if (!Number.isInteger(budget) || budget < 1 || budget > 100) throw new ConfigError("secrets.keepass.maxEntriesPerSession must be 1-100");
			let sync: { remote: string; timeoutSeconds: number } | undefined;
			if (kr.sync !== undefined) {
				const sy = object(kr.sync, "secrets.keepass.sync");
				requireKeys(sy, ["remote", "timeoutSeconds"], "secrets.keepass.sync.");
				if (typeof sy.remote !== "string" || !REMOTE_RE.test(sy.remote)) throw new ConfigError('secrets.keepass.sync.remote must be an rclone remote path such as "gdrive-ro:Folder/passwords.kdbx"');
				const to = num(sy.timeoutSeconds, 30, "secrets.keepass.sync.timeoutSeconds");
				if (!Number.isInteger(to) || to < 5 || to > 120) throw new ConfigError("secrets.keepass.sync.timeoutSeconds must be 5-120");
				sync = { remote: sy.remote, timeoutSeconds: to };
			}
			cfg.secrets.keepass = {
				path: absolutePath(kr.path, "/var/lib/pi-tg/keepass/main.kdbx", "secrets.keepass.path"),
				mode, storedSecret: stored, idleMinutes: idle, maxHours: maxH,
				hiddenTag: tag(kr.hiddenTag, "pitg-hidden", "secrets.keepass.hiddenTag"), confirmTag: tag(kr.confirmTag, "pitg-confirm", "secrets.keepass.confirmTag"),
				hiddenGroups: strArray(kr.hiddenGroups, [], "secrets.keepass.hiddenGroups"), confirmGroups: strArray(kr.confirmGroups, [], "secrets.keepass.confirmGroups"),
				maxFileMb: maxMb, maxArgonMiB: argon, maxEntriesPerSession: budget, ...(sync ? { sync } : {}),
			};
		}
	}

	if (o.model !== undefined) {
		if (typeof o.model !== "string" || !o.model.includes("/")) {
			throw new ConfigError('model must be "provider/model-id", e.g. "openai/gpt-5.6"');
		}
		cfg.model = o.model;
	}

	if (!["debug", "info", "warn", "error"].includes(cfg.logLevel)) throw new ConfigError(`bad logLevel ${cfg.logLevel}`);
	integerAtLeast(cfg.render.editThrottleMs, 1000, "render.editThrottleMs");
	integerAtLeast(cfg.render.maxChars, 1, "render.maxChars");
	if (cfg.render.maxChars > 4000) throw new ConfigError("render.maxChars must stay below the 4096 Telegram limit");
	integerAtLeast(cfg.render.maxEditsPerTurn, 0, "render.maxEditsPerTurn");
	integerAtLeast(cfg.render.notifyAfterMs, 0, "render.notifyAfterMs");
	integerAtLeast(cfg.turn.idleTimeoutMs, 60_000, "turn.idleTimeoutMs");
	integerAtLeast(cfg.coldStart.staleSeconds, 0, "coldStart.staleSeconds");
	if (!(cfg.files.maxDownloadMb > 0)) throw new ConfigError("files.maxDownloadMb must be > 0");
	if (!(cfg.files.maxUploadMb > 0)) throw new ConfigError("files.maxUploadMb must be > 0");
	if (!(cfg.files.retentionDays > 0)) throw new ConfigError("files.retentionDays must be > 0");
	if (cfg.files.outboxRoots.length === 0) throw new ConfigError("files.outboxRoots must not be empty");
	if (cfg.files.outboxRoots.some((path) => path === resolve(sep))) {
		throw new ConfigError("files.outboxRoots must not contain the filesystem root");
	}
	if (cfg.tools.deny.some((name) => name.includes("/") || name.includes("\\"))) {
		throw new ConfigError("tools.deny entries must be tool names, not paths");
	}
	if (cfg.tools.extraActive.some((name) => name.includes("/") || name.includes("\\"))) {
		throw new ConfigError("tools.extraActive entries must be tool names, not paths");
	}
	if (cfg.sessionDir === cfg.agentDir || cfg.sessionDir.startsWith(`${cfg.agentDir}${sep}`)) {
		throw new ConfigError("sessionDir must not live under agentDir — it would collide with interactive pi state");
	}

	return cfg;
}
