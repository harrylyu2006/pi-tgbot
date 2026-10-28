import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addThinkingBindingHeader,
	normalizeTransientRateLimitMessage,
	supportsThinkingBinding,
	thinkingBindingPayload,
	THINKING_BINDING_BETA,
} from "../src/agent/anthropic-thinking.ts";
import { isRetryableAssistantError } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js";
import { AgentHost } from "../src/agent/host.ts";

const official = { api: "anthropic-messages", id: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" };
for (const id of ["claude-sonnet-5-5", "claude-sonnet-5-5-20261001", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
	assert(supportsThinkingBinding({ ...official, id }));
}
for (const model of [
	{ ...official, api: "openai-responses" },
	{ ...official, id: "claude-sonnet-4-5" },
	{ ...official, id: "claude-sonnet-5-50" },
	{ ...official, baseUrl: "https://api.anthropic.com.example.org" },
	{ ...official, baseUrl: "http://api.anthropic.com" },
	{ ...official, baseUrl: "https://proxy.example.org" },
]) assert(!supportsThinkingBinding(model));
assert(!supportsThinkingBinding(undefined));

const headers = { "Anthropic-Beta": "existing-a,existing-b", "anthropic-beta": "existing-b", "x-other": "keep" };
addThinkingBindingHeader(headers);
const once = structuredClone(headers);
addThinkingBindingHeader(headers);
assert.deepEqual(headers, once);
assert.equal(headers["anthropic-beta"], `existing-a,existing-b,${THINKING_BINDING_BETA}`);
assert.equal(headers["x-other"], "keep");

const messages = [
	{ role: "user", content: "original question" },
	{ role: "assistant", content: [
		{ type: "thinking", thinking: "private", signature: "original-signature" },
		{ type: "text", text: "retained response" },
		{ type: "tool_use", id: "toolu_1", name: "probe", input: {} },
	] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "retained tool result" }] },
	{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
];
const adaptive = { model: official.id, system: "new prompt", messages, thinking: { type: "adaptive", display: "summarized" }, tools: [{ name: "probe" }], output_config: { effort: "high" } };
const original = structuredClone(adaptive);
const patched = thinkingBindingPayload(adaptive) as any;
assert.equal(patched.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
assert.equal(patched.thinking.display, "summarized");
assert.strictEqual(patched.messages, messages); // valid signed thinking is not rewritten
assert.deepEqual(thinkingBindingPayload(patched), patched);
assert.deepEqual(adaptive, original);
for (const thinking of [undefined, { type: "disabled" }, { type: "between_tools" }, { type: "enabled", budget_tokens: 1024 }]) {
	const input = { ...adaptive, thinking };
	const result = thinkingBindingPayload(input) as any;
	assert.deepEqual(result.thinking, thinking?.type === "disabled" ? { type: "between_tools" } : thinking); // binding is adaptive-only
	assert.equal(result.messages.length, 3); // omit a now-empty assistant message
	assert.deepEqual(result.messages[1].content, messages[1]!.content!.slice(1));
	assert.deepEqual(result.messages[2], messages[2]);
	assert.deepEqual(input.messages, messages); // persisted transcript untouched
}
assert.equal(thinkingBindingPayload({ messages: [{ role: "assistant", content: "text only" }] }), undefined);
assert.equal(thinkingBindingPayload(null), undefined);
assert.deepEqual((thinkingBindingPayload({ model: "claude-haiku-5-5", thinking: { type: "disabled" }, messages }) as any).thinking, { type: "disabled" });
const tpmErr = "Rate limit reached for gpt-6.1-sol in organization org-example on tokens per min (TPM): Limit 1000000, Used 939831, Requested 246327. Please try again in 11.169s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.";
assert.equal(isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: tpmErr } as never), false);
const normalizedTpm = normalizeTransientRateLimitMessage(tpmErr);
assert(normalizedTpm && !normalizedTpm.includes("/account/billing"));
assert.equal(isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: normalizedTpm } as never), true);
const quotaErr = "Rate limit reached: insufficient_quota. Please check your plan and billing details at https://platform.openai.com/account/billing.";
assert.equal(normalizeTransientRateLimitMessage(quotaErr), undefined);
console.log("✓ scope / header merge / adaptive and non-adaptive payload / transcript immutability / OpenAI TPM retry classification");

// Real AgentHost + SDK request serialization; no Telegram and no external API.
// Restart the host after changing AGENTS.md and verify that the same session,
// signed thinking and tool history survive while the API gets both controls.
const root = mkdtempSync(join(tmpdir(), "pi-tg-thinking-binding-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "not-a-real-key" } }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
	baseUrl: official.baseUrl, api: official.api, compat: { forceAdaptiveThinking: true }, models: [{
		id: official.id, name: "Binding Test", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 256,
	}],
} } }));
writeFileSync(join(agentDir, "AGENTS.md"), "Original system instruction");
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
function createHost() {
	return new AgentHost({
		config: { botToken: "unused", allowedUserId: 1, cwd: root, agentDir, sessionDir, logLevel: "error",
			render: { editThrottleMs: 1000, maxChars: 3800, maxEditsPerTurn: 10, notifyAfterMs: 30000 },
			tools: { deny: [], extraActive: [] }, turn: { idleTimeoutMs: 1200000 },
			model: `test/${official.id}`, extensions: [],
		} as any,
		log, onEvent() {}, onAbortRequested() {}, onShutdownRequested() {},
	});
}
const realFetch = globalThis.fetch;
const requests: { body: any; headers: Headers }[] = [];
function sse(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", role: "assistant", type: "message", model: official.id, content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Test reasoning" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-original-signature" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
let host = createHost();
try {
	await host.start();
	globalThis.fetch = (async (input: any, init?: RequestInit) => {
		assert(String(input) === "https://api.anthropic.com/v1/messages");
		requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
		return sse();
	}) as typeof fetch;
	const first = host.session as any;
	const sessionId = first.sessionId;
	assert(first.extensionRunner.hasHandlers("before_provider_headers"));
	assert(first.extensionRunner.hasHandlers("before_provider_request"));
	first.setThinkingLevel("high");
	await first.prompt("Reply OK");
	await host.stop();
	writeFileSync(join(agentDir, "AGENTS.md"), "Changed system instruction");
	host = createHost();
	await host.start();
	const resumed = host.session as any;
	assert.equal(resumed.sessionId, sessionId);
	await resumed.prompt("Continue after restart");
	assert.equal(requests.length, 2);
	for (const { body, headers: h } of requests) {
		assert.equal(body.thinking.type, "adaptive");
		assert.equal(body.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
		assert(h.get("anthropic-beta")?.split(",").includes(THINKING_BINDING_BETA));
	}
	assert.notDeepEqual(requests[0]!.body.system, requests[1]!.body.system);
	assert.equal(requests[1]!.body.messages[1].content[0].signature, "test-original-signature");
	assert.equal(resumed.messages.at(-1).stopReason, "stop");
	assert.equal(resumed.messages.at(-1).usage.output, 5);
	console.log("✓ real AgentHost / SDK / changed system after restart / same session / signed history / streaming and usage");
	resumed.setThinkingLevel("off");
	await resumed.prompt("Continue with thinking off");
	const off = requests.at(-1)!;
	assert.equal(off.body.thinking.type, "between_tools");
	assert.equal(off.body.thinking.block_binding, undefined);
	assert(!off.body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking")));
	assert(resumed.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "thinking")));
	console.log("✓ thinking-off wire fallback preserves transcript and avoids invalid block_binding");
} finally {
	globalThis.fetch = realFetch;
	await host.stop().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}
console.log("ANTHROPIC THINKING BINDING CHECK PASSED");
