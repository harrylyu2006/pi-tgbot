/**
 * Append-only audit log of every tool invocation.
 *
 * The operator accepted that a Telegram message equals root execution on this
 * box. That trade is only defensible if there is a record afterwards, so the
 * start record is written *before* the tool runs — a tool that hangs, crashes
 * the process, or takes the box down still leaves evidence of what was
 * attempted.
 *
 * Raw arguments and results are never recorded. Commands, search queries,
 * recipients and paths routinely contain private data; hashing a bounded,
 * redacted serialization still lets the operator correlate repeated calls
 * without creating a second plaintext transcript.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { errFields, redact, type Logger } from "../log.ts";

const MAX_HASH_BYTES = 64 * 1024;

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
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			closeSync(openSync(this.path, "a", 0o600));
			chmodSync(this.path, 0o600);
			this.log.info({ msg: "audit log ready" });
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

	private static summarizeArgs(args: unknown): { argBytes: number; argHash: string; hashTruncated: boolean } {
		let json: string;
		try {
			json = JSON.stringify(redact(args)) ?? "null";
		} catch {
			json = "[unserializable]";
		}
		const bytes = Buffer.byteLength(json);
		return {
			argBytes: bytes,
			argHash: createHash("sha256").update(Buffer.from(json).subarray(0, MAX_HASH_BYTES)).digest("hex"),
			hashTruncated: bytes > MAX_HASH_BYTES,
		};
	}

	/** Called on tool_execution_start, before the tool has run. */
	start(ctx: { generation: number; toolCallId: string; toolName: string; args: unknown }): void {
		this.startedAt.set(ctx.toolCallId, Date.now());
		this.write({
			phase: "start",
			gen: ctx.generation,
			toolCallId: ctx.toolCallId,
			tool: ctx.toolName,
			...AuditLog.summarizeArgs(ctx.args),
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
