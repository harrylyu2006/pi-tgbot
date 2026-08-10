/**
 * Configuration loading and validation.
 *
 * Unknown keys are a hard error. This is deliberate: `tools.deny` is a safety
 * control, and a typo like `tools.denied` would silently leave bash enabled
 * while looking configured. Failing loudly at boot beats discovering it later.
 */

import { readFileSync } from "node:fs";
import type { Level } from "./log.ts";

export interface RenderConfig {
	/** Minimum ms between editMessageText calls for one message id. */
	editThrottleMs: number;
	/** Target body size. Below 4096 because HTML entity expansion inflates it. */
	maxChars: number;
	/** Hard ceiling on edits per turn, so a pathological tool loop can't burn the rate budget. */
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
	/** Append-only tool audit log. */
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
	render: { editThrottleMs: 2500, maxChars: 3800, maxEditsPerTurn: 120, notifyAfterMs: 30_000 },
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

function num(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ConfigError(`${path} must be a number`);
	return value;
}

function strArray(value: unknown, fallback: string[], path: string): string[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new ConfigError(`${path} must be an array of strings`);
	}
	return value as string[];
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
	if (typeof o.allowedUserId !== "number" || !Number.isInteger(o.allowedUserId)) {
		throw new ConfigError("allowedUserId must be an integer Telegram user id");
	}

	const renderRaw = (o.render ?? {}) as Record<string, unknown>;
	requireKeys(renderRaw, ["editThrottleMs", "maxChars", "maxEditsPerTurn", "notifyAfterMs"], "render.");
	const toolsRaw = (o.tools ?? {}) as Record<string, unknown>;
	requireKeys(toolsRaw, ["deny", "extraActive"], "tools.");
	const turnRaw = (o.turn ?? {}) as Record<string, unknown>;
	requireKeys(turnRaw, ["idleTimeoutMs"], "turn.");

	const cfg: Config = {
		botToken: o.botToken,
		allowedUserId: o.allowedUserId,
		cwd: typeof o.cwd === "string" ? o.cwd : DEFAULTS.cwd,
		agentDir: typeof o.agentDir === "string" ? o.agentDir : DEFAULTS.agentDir,
		sessionDir: typeof o.sessionDir === "string" ? o.sessionDir : DEFAULTS.sessionDir,
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
		statePath: typeof o.statePath === "string" ? o.statePath : DEFAULTS.statePath,
		auditPath: typeof o.auditPath === "string" ? o.auditPath : DEFAULTS.auditPath,
		extensions: strArray(o.extensions, DEFAULTS.extensions, "extensions"),
		coldStart: {
			staleSeconds: num((o.coldStart as Record<string, unknown> | undefined)?.staleSeconds, DEFAULTS.coldStart.staleSeconds, "coldStart.staleSeconds"),
		},
		files: (() => {
			const f = (o.files ?? {}) as Record<string, unknown>;
			requireKeys(f, ["inboxDir", "outboxRoots", "maxDownloadMb", "maxUploadMb", "retentionDays"], "files.");
			return {
				inboxDir: typeof f.inboxDir === "string" ? f.inboxDir : DEFAULTS.files.inboxDir,
				outboxRoots: strArray(f.outboxRoots, DEFAULTS.files.outboxRoots, "files.outboxRoots"),
				maxDownloadMb: num(f.maxDownloadMb, DEFAULTS.files.maxDownloadMb, "files.maxDownloadMb"),
				maxUploadMb: num(f.maxUploadMb, DEFAULTS.files.maxUploadMb, "files.maxUploadMb"),
				retentionDays: num(f.retentionDays, DEFAULTS.files.retentionDays, "files.retentionDays"),
			};
		})(),
	};

	if (o.coldStart !== undefined) requireKeys(o.coldStart as Record<string, unknown>, ["staleSeconds"], "coldStart.");

	if (o.model !== undefined) {
		if (typeof o.model !== "string" || !o.model.includes("/")) {
			throw new ConfigError('model must be "provider/model-id", e.g. "openai/gpt-5.6"');
		}
		cfg.model = o.model;
	}

	if (!["debug", "info", "warn", "error"].includes(cfg.logLevel)) throw new ConfigError(`bad logLevel ${cfg.logLevel}`);
	if (cfg.render.maxChars > 4000) throw new ConfigError("render.maxChars must stay below the 4096 Telegram limit");
	if (cfg.render.editThrottleMs < 1000) throw new ConfigError("render.editThrottleMs below 1000 will hit per-chat rate limits");
	if (cfg.turn.idleTimeoutMs < 60_000) throw new ConfigError("turn.idleTimeoutMs must be at least 60000");
	if (cfg.sessionDir.startsWith(`${cfg.agentDir}/sessions`)) {
		throw new ConfigError("sessionDir must not live under the shared agent session dir — it would collide with interactive pi");
	}

	return cfg;
}
