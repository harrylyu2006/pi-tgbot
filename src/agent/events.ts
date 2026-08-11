/**
 * Translates the session event stream into LiveMessage updates.
 *
 * Three probe-verified facts drive this file:
 *
 *  - `event.message.content` is an array of blocks whose `text` is CUMULATIVE.
 *    Concatenating `assistantMessageEvent.delta` by hand looks equivalent and
 *    silently breaks on multi-block messages, so we always read the cumulative
 *    value instead.
 *  - `agent_settled` is the only terminal signal. `agent_end` carries
 *    `willRetry` and fires again on retries; treating it as the end truncates
 *    the answer at the first hiccup.
 *  - Observed order: agent_start → turn_start → message_start →
 *    message_update×N → message_end → turn_end → agent_end → agent_settled.
 *
 * Besides the answer path this router also renders *live activity*: running
 * tools (bounded input previews and accumulated output tails, correlated by
 * toolCallId), intermediate model phases (thinking / responding / preparing a
 * tool call), queued steering and follow-up prompts, compaction and retry
 * states. Every activity item is capped at two physical lines and the whole
 * block is bounded, so a verbose turn cannot crowd the answer out of the
 * shared Telegram message. Completed/error tool states stay visible until the
 * next event replaces them; outbound redaction happens downstream in
 * LiveMessage.setActivity.
 */

import type { Logger } from "../log.ts";

export interface TurnSink {
	onStart(): void;
	onAnswer(cumulative: string): void;
	/** Provider-visible reasoning summary / chain-of-thought, when the API exposes it. */
	onThinking(cumulative: string): void;
	onActivity(line: string): void;
	onSettled(finalText: string): void;
}

/** Pull the stop reason off whichever event carried the finished message. */
function stopReasonOf(event: any): string | null {
	const m = event?.message;
	return m && typeof m === "object" && typeof m.stopReason === "string" ? m.stopReason : null;
}

/** Reasoning tokens spent, for explaining a budget that thinking ate. */
function reasoningTokensOf(event: any): number {
	const u = event?.message?.usage;
	return u && typeof u === "object" && typeof u.reasoning === "number" ? u.reasoning : 0;
}

/** Pull a provider error out of whichever event carried it. */
function errorOf(event: any): string | null {
	const m = event?.message;
	if (m && typeof m === "object" && m.stopReason === "error") {
		return typeof m.errorMessage === "string" ? m.errorMessage : "provider returned an error";
	}
	if (typeof event?.error === "string") return event.error;
	return null;
}

/** Pull the cumulative assistant text out of whatever block shape arrived. */
export function cumulativeText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") out.push(b.text);
	}
	return out.join("");
}

/** Pull cumulative provider-visible thinking blocks out of a partial message. */
export function cumulativeThinking(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; thinking?: string; redacted?: boolean };
		if (b.type === "thinking" && b.redacted !== true && typeof b.thinking === "string") out.push(b.thinking);
	}
	return out.join("");
}

export interface ToolSink {
	/** Fired before the tool runs — the audit record must exist by then. */
	start(info: { toolCallId: string; toolName: string; args: unknown }): void;
	end(info: { toolCallId: string; toolName: string; isError?: boolean; result?: unknown }): void;
}

export interface EventRouterDeps {
	log: Logger;
	sink: TurnSink;
	tools?: ToolSink;
	/** Generation this router is fenced to; stale events render nowhere. */
	currentGeneration: () => number;
}

/** One in-flight tool, keyed by toolCallId. */
interface RunningTool {
	name: string;
	/** One collapsed line previewing the input actually being executed. */
	detail: string;
	/** Bounded tail of the accumulated partial output (may be ""). */
	progress: string;
	/** Bounded accumulation of streamed partial text, so it never grows unbounded. */
	acc: string;
}

type Phase = "" | "thinking" | "responding" | "toolcall";

const ACTIVITY_MAX_LINES = 5;
const ACTIVITY_MAX_CHARS = 480;

function truncateLine(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Collapse a possibly multiline input into ONE bounded line: the first two
 * non-empty source lines joined by " │ ", with "…" appended when more exists.
 * Keeps the per-item footprint at exactly two physical lines (header + this).
 */
function collapseDetail(value: unknown, maxLen = 120): string {
	if (typeof value !== "string") return "";
	const lines = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	const keep = lines.slice(start, end);
	if (keep.length === 0) return "";
	const first = truncateLine(keep[0] ?? "", maxLen);
	if (keep.length === 1) return first;
	const second = truncateLine(keep[1] ?? "", Math.max(1, maxLen - first.length - 3));
	const joined = `${first} │ ${second}`;
	return keep.length > 2 ? `${joined} …` : joined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Up to two concise scalar arguments for extension tools; nested objects never leak. */
const SENSITIVE_ARG = /(?:^|_)(?:authorization|cookie|password|passwd|pwd|secret|token|api_?key|private_?key)(?:$|_)/i;

function scalarArgs(args: Record<string, unknown>, max = 2): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		// Generic extension tools can put credentials in otherwise innocent scalar
		// fields. Never include a value whose key itself identifies it as secret;
		// redactOutbound remains the second, format-based line of defence.
		if (SENSITIVE_ARG.test(key)) continue;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		const one = String(value).replace(/\s+/g, " ").trim();
		if (!one) continue;
		parts.push(`${key}: ${truncateLine(one, 60)}`);
		if (parts.length === max) break;
	}
	return parts.join(" · ");
}

/**
 * Human-readable, bounded summary of the input actually being executed.
 * Never dumps write/edit contents or nested secrets.
 */
export function toolActivityDetail(toolName: string, args: unknown): string {
	const a = record(args);
	switch (toolName) {
		case "bash":
			return collapseDetail(a.command);
		case "read": {
			const path = typeof a.path === "string" ? a.path : "";
			const offset = typeof a.offset === "number" ? a.offset : undefined;
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			const range =
				offset !== undefined || limit !== undefined
					? `行 ${offset ?? 1}${limit !== undefined ? ` 起，最多 ${limit} 行` : " 起"}`
					: "";
			return [truncateLine(path, 60), range].filter(Boolean).join(" · ");
		}
		case "edit": {
			const count = Array.isArray(a.edits) ? a.edits.length : 0;
			const path = typeof a.path === "string" ? truncateLine(a.path, 60) : "";
			return [path, count > 0 ? `${count} 处修改` : ""].filter(Boolean).join(" · ");
		}
		case "write": {
			const size = typeof a.content === "string" ? a.content.length : 0;
			const path = typeof a.path === "string" ? truncateLine(a.path, 60) : "";
			return [path, size > 0 ? `写入 ${size} 个字符` : ""].filter(Boolean).join(" · ");
		}
		case "grep": {
			const pattern = typeof a.pattern === "string" ? `/${a.pattern}/` : "";
			const path = typeof a.path === "string" ? a.path : "";
			return [truncateLine(pattern, 60), truncateLine(path, 50)].filter(Boolean).join(" · ");
		}
		case "find": {
			const pattern = typeof a.pattern === "string" ? a.pattern : "";
			const path = typeof a.path === "string" ? a.path : "";
			return [truncateLine(pattern, 60), truncateLine(path, 50)].filter(Boolean).join(" · ");
		}
		case "ls":
			return typeof a.path === "string" ? truncateLine(a.path, 80) : ".";
		case "web_fetch":
			return collapseDetail(a.url, 100);
		case "brave_search": {
			const query =
				typeof a.query === "string"
					? a.query
					: Array.isArray(a.queries)
						? a.queries.filter((v): v is string => typeof v === "string").join("\n")
						: "";
			return collapseDetail(query, 100);
		}
		default:
			return scalarArgs(a);
	}
}

/** Latest non-empty line of accumulated streamed output, bounded. */
function tailSummary(text: string, maxLen = 120): string {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== "");
	return truncateLine(lines[lines.length - 1] ?? "", maxLen);
}

/** Text payload of a tool_execution_update partialResult. */
function partialText(partial: unknown): string {
	const p = record(partial);
	const content = p.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const block of content) {
			const b = record(block);
			if (b.type === "text" && typeof b.text === "string") out += b.text;
		}
		return out;
	}
	return "";
}

function boundActivity(block: string): string {
	const lines = block.split("\n");
	const kept = lines.length > ACTIVITY_MAX_LINES ? lines.slice(0, ACTIVITY_MAX_LINES) : lines;
	let out = kept.join("\n");
	if (out.length > ACTIVITY_MAX_CHARS) out = `${out.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;
	return out;
}

export function createEventRouter(deps: EventRouterDeps): (generation: number, event: any) => void {
	let latestAnswer = "";
	let latestThinking = "";
	let latestError: string | null = null;
	let latestStop: string | null = null;
	let latestReasoning = 0;
	const toolsRunning = new Map<string, RunningTool>();
	let toolsDone = 0;
	let turnStartedAt = 0;
	let phase: Phase = "";
	let pendingTool: { name: string; detail: string } | null = null;
	let lastTool: { name: string; isError: boolean } | null = null;
	let queuedSteering: string[] = [];
	let queuedFollowUp: string[] = [];
	let compacting = false;
	let retryInfo: { attempt: number; maxAttempts: number } | null = null;
	let summarizing: { attempt: number; maxAttempts: number } | null = null;
	let briefNote = "";
	let lastActivity = "";

	function preview(value: unknown): string {
		const collapsed = collapseDetail(value, 60);
		return collapsed || "（无文字）";
	}

	function replaceTransientActivity(): void {
		// A lifecycle phase, completed tool or retry note is deliberately brief:
		// the next meaningful event supersedes it instead of building a status log.
		lastTool = null;
		briefNote = "";
	}

	function activityLine(): string {
		const parts: string[] = [];
		const elapsed = turnStartedAt ? Math.round((Date.now() - turnStartedAt) / 1000) : 0;

		if (compacting) parts.push("🧹 正在压缩上下文…");
		if (retryInfo) parts.push(`↻ 自动重试中（${retryInfo.attempt}/${retryInfo.maxAttempts}）…`);
		if (summarizing) parts.push(`↻ 摘要重试中（${summarizing.attempt}/${summarizing.maxAttempts}）…`);
		if (briefNote) parts.push(briefNote);

		const running = [...toolsRunning.entries()];
		if (running.length > 0) {
			const current = running[running.length - 1]?.[1];
			if (current) {
				// One header line + one detail line: the hard two-line budget per item.
				const header = `⏳ ${current.name}${running.length > 1 ? ` ＋${running.length - 1} 并行` : ""} · ${elapsed}s`;
				const detail = current.progress || current.detail;
				parts.push(detail ? `${header}\n${detail}` : header);
			}
		} else if (phase === "thinking") {
			parts.push("💭 思考中…");
		} else if (phase === "toolcall" && pendingTool) {
			const header = `🔧 即将调用 ${pendingTool.name} · ${elapsed}s`;
			parts.push(pendingTool.detail ? `${header}\n${pendingTool.detail}` : header);
		} else if (lastTool) {
			// Completed/error state: visible until the next event replaces it.
			parts.push(lastTool.isError ? `⚠️ ${lastTool.name} 失败 · ${elapsed}s` : `✅ ${lastTool.name} 完成 · ${elapsed}s`);
		} else if (phase === "responding" && !latestAnswer.trim()) {
			parts.push("✍️ 正在回复…");
		} else if (toolsDone > 0) {
			parts.push(`🔧 ${toolsDone} 个工具 · ${elapsed}s`);
		}

		if (queuedSteering.length > 0) parts.push(`⏭ 队列（${queuedSteering.length}）：${preview(queuedSteering[0])}`);
		if (queuedFollowUp.length > 0) parts.push(`📌 后续：${preview(queuedFollowUp[0])}`);

		if (parts.length === 0) return "";
		return boundActivity(parts.join("\n"));
	}

	/** Push the current activity only when it actually changed (latest-wins). */
	function refreshActivity(): void {
		const line = activityLine();
		if (line === lastActivity) return;
		lastActivity = line;
		briefNote = ""; // one-shot notes are consumed by the frame they appear in
		deps.sink.onActivity(line);
	}

	return function route(generation: number, event: any): void {
		if (generation !== deps.currentGeneration()) return; // stale session
		const type = event?.type;

		// A provider failure (401, rate limit, upstream down) arrives as a message
		// with stopReason "error" and no text. Swallowing it leaves the operator
		// staring at a placeholder that never fills in — which is exactly how a
		// blocked API key looked like "the bot is broken" for half an hour.
		const stop = stopReasonOf(event);
		if (stop) {
			latestStop = stop;
			latestReasoning = reasoningTokensOf(event) || latestReasoning;
		}

		const err = errorOf(event);
		if (err) {
			latestError = err;
			deps.log.error({ msg: "provider error during turn", detail: err.slice(0, 400) });
		}

		switch (type) {
			case "agent_start": {
				latestAnswer = "";
				latestThinking = "";
				latestError = null;
				latestStop = null;
				latestReasoning = 0;
				toolsRunning.clear();
				toolsDone = 0;
				turnStartedAt = Date.now();
				phase = "";
				pendingTool = null;
				lastTool = null;
				queuedSteering = [];
				queuedFollowUp = [];
				compacting = false;
				retryInfo = null;
				summarizing = null;
				briefNote = "";
				deps.sink.onStart();
				refreshActivity();
				break;
			}
			case "message_start":
				phase = event.message?.role === "assistant" ? "thinking" : "";
				replaceTransientActivity();
				refreshActivity();
				break;
			case "message_update": {
				const text = cumulativeText(event.message);
				if (text && text !== latestAnswer) {
					latestAnswer = text;
					deps.sink.onAnswer(text);
				}
				const thinking = cumulativeThinking(event.message);
				if (thinking !== latestThinking) {
					latestThinking = thinking;
					deps.sink.onThinking(thinking);
				}
				const et = event.assistantMessageEvent;
				const etType = et && typeof et === "object" && typeof et.type === "string" ? et.type : "";
				if (etType.startsWith("thinking")) {
					phase = "thinking";
					pendingTool = null;
				} else if (etType === "toolcall_start" || etType === "toolcall_delta") {
					const partial = record(et.partial);
					const content = Array.isArray(partial.content) ? partial.content : [];
					const block = record(content[Number(et.contentIndex)]);
					const name = typeof block.name === "string" && block.name ? block.name : "工具";
					pendingTool = { name, detail: toolActivityDetail(name, block.arguments) };
					phase = "toolcall";
				} else if (etType === "toolcall_end") {
					const call = record(et.toolCall);
					const name = typeof call.name === "string" ? call.name : "工具";
					pendingTool = { name, detail: toolActivityDetail(name, call.arguments) };
					phase = "toolcall";
				} else if (etType.startsWith("text")) {
					phase = "responding";
					pendingTool = null;
				}
				replaceTransientActivity();
				refreshActivity();
				break;
			}
			case "message_end": {
				const text = cumulativeText(event.message);
				if (text && text !== latestAnswer) {
					latestAnswer = text;
					deps.sink.onAnswer(text);
				}
				const thinking = cumulativeThinking(event.message);
				if (thinking !== latestThinking) {
					latestThinking = thinking;
					deps.sink.onThinking(thinking);
				}
				phase = "";
				refreshActivity();
				break;
			}
			case "turn_start":
				phase = "thinking";
				replaceTransientActivity();
				refreshActivity();
				break;
			case "turn_end":
				phase = "";
				refreshActivity();
				break;
			case "tool_execution_start": {
				const id = String(event.toolCallId ?? event.id ?? toolsRunning.size);
				const name = String(event.toolName ?? event.tool ?? "tool");
				toolsRunning.set(id, { name, detail: toolActivityDetail(name, event.args), progress: "", acc: "" });
				phase = "";
				pendingTool = null;
				replaceTransientActivity();
				// Audit first: the record has to exist even if the tool never returns.
				deps.tools?.start({ toolCallId: id, toolName: name, args: event.args });
				refreshActivity();
				break;
			}
			case "tool_execution_update": {
				const id = String(event.toolCallId ?? event.id ?? "");
				const tool = toolsRunning.get(id);
				if (tool) {
					const text = partialText(event.partialResult);
					if (text) {
						tool.acc = `${tool.acc}${text}`.slice(-400);
						tool.progress = tailSummary(tool.acc);
					}
				}
				refreshActivity();
				break;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId ?? event.id ?? "");
				const name = String(event.toolName ?? event.tool ?? "tool");
				const running = toolsRunning.get(id);
				toolsRunning.delete(id);
				lastTool = { name: running?.name ?? name, isError: Boolean(event.isError) };
				toolsDone++;
				deps.tools?.end({ toolCallId: id, toolName: name, isError: event.isError, result: event.result });
				refreshActivity();
				break;
			}
			case "queue_update": {
				queuedSteering = Array.isArray(event.steering) ? event.steering.filter((s: unknown): s is string => typeof s === "string") : [];
				queuedFollowUp = Array.isArray(event.followUp) ? event.followUp.filter((s: unknown): s is string => typeof s === "string") : [];
				replaceTransientActivity();
				refreshActivity();
				break;
			}
			case "compaction_start":
				compacting = true;
				refreshActivity();
				break;
			case "compaction_end":
				compacting = false;
				refreshActivity();
				break;
			case "auto_retry_start":
				retryInfo = { attempt: Number(event.attempt) || 0, maxAttempts: Number(event.maxAttempts) || 0 };
				refreshActivity();
				break;
			case "auto_retry_end":
				retryInfo = null;
				refreshActivity();
				break;
			case "summarization_retry_scheduled":
			case "summarization_retry_attempt_start":
				summarizing = { attempt: Number(event.attempt) || 0, maxAttempts: Number(event.maxAttempts) || 0 };
				refreshActivity();
				break;
			case "summarization_retry_finished":
				summarizing = null;
				refreshActivity();
				break;
			case "thinking_level_changed": {
				if (typeof event.level === "string" && event.level) {
					briefNote = `🧠 思考等级：${event.level}`;
					refreshActivity();
				}
				break;
			}
			case "extension_error": {
				const detail = typeof event.error === "string" ? collapseDetail(event.error, 100) : "";
				briefNote = detail ? `⚠️ 扩展错误：${detail}` : "⚠️ 扩展执行出错";
				refreshActivity();
				break;
			}
			case "agent_end": {
				// Not terminal when a retry is pending — wait for agent_settled.
				if (event.willRetry) {
					briefNote = "↻ 重试中…";
					refreshActivity();
				}
				break;
			}
			case "agent_settled": {
				// The final render replaces the live message entirely; drop the
				// transient activity state so nothing stale leaks into it.
				phase = "";
				pendingTool = null;
				lastTool = null;
				queuedSteering = [];
				queuedFollowUp = [];
				compacting = false;
				retryInfo = null;
				summarizing = null;
				briefNote = "";
				// `length` means the model ran out of output budget. With thinking on,
				// reasoning can consume the entire budget and leave zero prose — which
				// renders as a blank message unless we say what happened.
				if (latestStop === "length") {
					const spent = latestReasoning > 0 ? `（思考用掉 ${latestReasoning} tokens）` : "";
					deps.log.warn({ msg: "response truncated by output budget", reasoningTokens: latestReasoning, hadText: latestAnswer.trim().length > 0 });
					if (!latestAnswer.trim()) {
						deps.sink.onSettled(
							`⚠️ **输出预算被耗尽，没有产出正文**${spent}\n\n` +
								"降低思考等级（/start → 🧠 思考 → medium/low），或调高该模型的 maxTokens。",
						);
					} else {
						deps.sink.onSettled(`${latestAnswer}\n\n---\n⚠️ *回答被输出上限截断${spent}*`);
					}
					break;
				}
				if (!latestAnswer.trim() && latestError) {
					deps.sink.onSettled(`⚠️ **这一轮没能完成** — 模型服务返回了错误：\n\n\`\`\`\n${latestError.slice(0, 700)}\n\`\`\``);
				} else {
					deps.sink.onSettled(latestAnswer);
				}
				break;
			}
			default:
				break;
		}
	};
}
