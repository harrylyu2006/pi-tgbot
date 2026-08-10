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
 */

import type { Logger } from "../log.ts";

export interface TurnSink {
	onStart(): void;
	onAnswer(cumulative: string): void;
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

export function createEventRouter(deps: EventRouterDeps): (generation: number, event: any) => void {
	let latestAnswer = "";
	let latestError: string | null = null;
	let latestStop: string | null = null;
	let latestReasoning = 0;
	const toolsRunning = new Map<string, string>();
	let toolsDone = 0;
	let turnStartedAt = 0;

	function activityLine(): string {
		const running = [...toolsRunning.values()];
		if (running.length === 0 && toolsDone === 0) return "";
		const elapsed = turnStartedAt ? Math.round((Date.now() - turnStartedAt) / 1000) : 0;
		if (running.length > 0) return `⏳ ${running[running.length - 1]}  ·  ${elapsed}s`;
		return `🔧 ${toolsDone} 个工具 · ${elapsed}s`;
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
				latestError = null;
				latestStop = null;
				latestReasoning = 0;
				toolsRunning.clear();
				toolsDone = 0;
				turnStartedAt = Date.now();
				deps.sink.onStart();
				break;
			}
			case "message_update": {
				const text = cumulativeText(event.message);
				if (text && text !== latestAnswer) {
					latestAnswer = text;
					deps.sink.onAnswer(text);
				}
				break;
			}
			case "tool_execution_start": {
				const id = String(event.toolCallId ?? event.id ?? toolsRunning.size);
				const name = String(event.toolName ?? event.tool ?? "tool");
				toolsRunning.set(id, name);
				// Audit first: the record has to exist even if the tool never returns.
				deps.tools?.start({ toolCallId: id, toolName: name, args: event.args });
				deps.sink.onActivity(activityLine());
				break;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId ?? event.id ?? "");
				const name = String(event.toolName ?? event.tool ?? "tool");
				toolsRunning.delete(id);
				toolsDone++;
				deps.tools?.end({ toolCallId: id, toolName: name, isError: event.isError, result: event.result });
				deps.sink.onActivity(activityLine());
				break;
			}
			case "agent_end": {
				// Not terminal when a retry is pending — wait for agent_settled.
				if (event.willRetry) deps.sink.onActivity("↻ 重试中…");
				break;
			}
			case "agent_settled": {
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
