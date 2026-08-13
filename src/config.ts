/**
 * Configuration loading and validation.
 *
 * Unknown keys are a hard error. This is deliberate: `tools.deny` is a safety
 * control, and a typo like `tools.denied` would silently leave bash enabled
 * while looking configured. Failing loudly at boot beats discovering it later.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Level } from "./log.ts";

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
			"render", "tools", "turn", "statePath", "auditPath", "coldStart", "files", "extensions",
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
