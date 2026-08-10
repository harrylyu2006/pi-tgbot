/**
 * Append-only audit log of every tool invocation.
 *
 * The operator accepted that a Telegram message equals root execution on this
 * box. That trade is only defensible if there is a record afterwards, so the
 * start record is written *before* the tool runs — a tool that hangs, crashes
 * the process, or takes the box down still leaves evidence of what was
 * attempted.
 *
 * Arguments are recorded, results are not: a `read` of a private key would
 * otherwise copy that key into a second file with a different retention policy.
 * Result size and error status are enough to reconstruct what happened.
 */

import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { errFields, redact, type Logger } from "../log.ts";

const MAX_ARG_BYTES = 4096;

export class AuditLog {
	private readonly path: string;
	private readonly log: Logger;
	private readonly startedAt = new Map<string, number>();

	constructor(path: string, log: Logger) {
		this.path = path;
		this.log = log;
	}

	init(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			closeSync(openSync(this.path, "a", 0o600));
			this.log.info({ msg: "audit log ready", path: this.path });
		} catch (err) {
			// Losing the audit log must not take the daemon down, but it must be
			// loud: from here on the root-execution trade is unbacked.
			this.log.error({ msg: "AUDIT LOG UNAVAILABLE — tool calls will not be recorded", path: this.path, ...errFields(err) });
		}
	}

	private write(record: Record<string, unknown>): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
		} catch (err) {
			this.log.warn({ msg: "audit write failed", ...errFields(err) });
		}
	}

	private static truncateArgs(args: unknown): { args: unknown; truncated: boolean } {
		const redacted = redact(args);
		const json = JSON.stringify(redacted) ?? "null";
		if (json.length <= MAX_ARG_BYTES) return { args: redacted, truncated: false };
		return { args: `${json.slice(0, MAX_ARG_BYTES)}…`, truncated: true };
	}

	/** Called on tool_execution_start, before the tool has run. */
	start(ctx: { sessionId: string; generation: number; toolCallId: string; toolName: string; args: unknown }): void {
		this.startedAt.set(ctx.toolCallId, Date.now());
		const { args, truncated } = AuditLog.truncateArgs(ctx.args);
		this.write({
			phase: "start",
			sessionId: ctx.sessionId,
			gen: ctx.generation,
			toolCallId: ctx.toolCallId,
			tool: ctx.toolName,
			args,
			truncated,
		});
	}

	/** Called on tool_execution_end. */
	end(ctx: { toolCallId: string; toolName: string; isError?: boolean; result?: unknown }): void {
		const began = this.startedAt.get(ctx.toolCallId);
		this.startedAt.delete(ctx.toolCallId);
		let resultBytes = 0;
		try {
			resultBytes = ctx.result === undefined ? 0 : (JSON.stringify(ctx.result) ?? "").length;
		} catch {
			resultBytes = -1; // unserializable; the size is not worth a crash
		}
		this.write({
			phase: "end",
			toolCallId: ctx.toolCallId,
			tool: ctx.toolName,
			isError: Boolean(ctx.isError),
			resultBytes,
			durMs: began === undefined ? null : Date.now() - began,
		});
	}
}
