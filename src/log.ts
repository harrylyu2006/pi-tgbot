/**
 * Structured logging to stdout for journald.
 *
 * One JSON object per line, no file handling — systemd owns the log stream.
 * Conversation content is deliberately never logged: prompt bodies and model
 * output live in the session JSONL, and journald on a box shared with other
 * production services is the wrong place for them. Only lengths and ids.
 */

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVEL_ORDER.info;

export function setLevel(level: Level): void {
	threshold = LEVEL_ORDER[level];
}

const SECRET_KEY = /^(.*(token|key|secret|password|authorization).*)$/i;
const BOT_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;

/** Strip anything token-shaped before it reaches the log stream. */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 6) return "[deep]";
	if (typeof value === "string") return value.replace(BOT_TOKEN, "[REDACTED_TOKEN]");
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
		}
		return out;
	}
	return value;
}

export interface Logger {
	debug(fields: Record<string, unknown>): void;
	info(fields: Record<string, unknown>): void;
	warn(fields: Record<string, unknown>): void;
	error(fields: Record<string, unknown>): void;
	child(comp: string): Logger;
}

function emit(level: Level, comp: string, fields: Record<string, unknown>): void {
	if (LEVEL_ORDER[level] < threshold) return;
	const record = { ts: new Date().toISOString(), level, comp, ...(redact(fields) as Record<string, unknown>) };
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function createLogger(comp: string): Logger {
	return {
		debug: (f) => emit("debug", comp, f),
		info: (f) => emit("info", comp, f),
		warn: (f) => emit("warn", comp, f),
		error: (f) => emit("error", comp, f),
		child: (sub) => createLogger(`${comp}.${sub}`),
	};
}

/** Errors do not survive JSON.stringify; flatten them at the boundary. */
export function errFields(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		const extra: Record<string, unknown> = {};
		for (const k of ["kind", "status", "description", "retryAfter", "method"]) {
			const v = (err as unknown as Record<string, unknown>)[k];
			if (v !== undefined) extra[k] = v;
		}
		return { err: err.message, errName: err.name, ...extra };
	}
	// Plain objects stringify to "[object Object]", which throws away the only
	// evidence there was. Extensions throw such values, so serialize them.
	if (err && typeof err === "object") {
		try {
			return { err: JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 2000) };
		} catch {
			return { err: Object.prototype.toString.call(err), errKeys: Object.keys(err as object) };
		}
	}
	return { err: String(err) };
}
