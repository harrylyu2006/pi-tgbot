import { streamSimple } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { enrichThinkingLevels, type ModelLike } from "../src/agent/reasoning.ts";

interface PayloadModel extends ModelLike {
	id: string;
	provider: string;
	api: "openai-completions";
	baseUrl: string;
	input: ["text"];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type CapturedPayload = Record<string, unknown>;

let failures = 0;
function ok(name: string, cond: boolean, detail?: string): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : detail ? `\n      ${detail}` : ""}`);
}

function model(provider: string, id: string, compat?: Record<string, unknown>): PayloadModel {
	return enrichThinkingLevels({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, ...compat },
	}) as PayloadModel;
}

async function capture(modelValue: PayloadModel, reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): Promise<CapturedPayload> {
	let payload: CapturedPayload | undefined;
	const stream = streamSimple(
		modelValue as never,
		{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
		{
			apiKey: "not-a-real-key",
			reasoning: reasoning as never,
			onPayload: (params: unknown) => {
				payload = params as CapturedPayload;
				throw new Error("payload captured");
			},
		},
	);
	await stream.result();
	if (!payload) throw new Error(`No payload captured for ${modelValue.provider}/${modelValue.id} at ${reasoning}`);
	return payload;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

console.log("DeepSeek 原生与 OpenRouter 请求分流：");
{
	const native = model("custom", "deepseek-v4-flash");
	const off = await capture(native, "off");
	const high = await capture(native, "high");
	const max = await capture(native, "max");
	ok("原生 off 发送 thinking.disabled", json(off.thinking) === json({ type: "disabled" }), json(off));
	ok("原生 high 发送 thinking.enabled + high", json(high.thinking) === json({ type: "enabled" }) && high.reasoning_effort === "high", json(high));
	ok("原生 max 发送 max", max.reasoning_effort === "max", json(max));

	const openrouter = model("openrouter", "deepseek/deepseek-v4-flash");
	const routed = await capture(openrouter, "xhigh");
	ok("OpenRouter 发送 nested reasoning", json(routed.reasoning) === json({ effort: "xhigh" }), json(routed));
	ok("OpenRouter 不发送 DeepSeek thinking 字段", routed.thinking === undefined && routed.reasoning_effort === undefined, json(routed));
}

console.log("GLM-5.2 折叠行为：");
{
	const glm = model("custom", "glm-5.2");
	const off = await capture(glm, "off");
	const low = await capture(glm, "low");
	const medium = await capture(glm, "medium");
	const high = await capture(glm, "high");
	const xhigh = await capture(glm, "xhigh");
	const max = await capture(glm, "max");
	ok("off 只关闭 thinking，不发送 effort none", json(off.thinking) === json({ type: "disabled" }) && off.reasoning_effort === undefined, json(off));
	ok("low 折叠 high", low.reasoning_effort === "high", json(low));
	ok("medium 折叠 high", medium.reasoning_effort === "high", json(medium));
	ok("high 发送 high", high.reasoning_effort === "high", json(high));
	ok("xhigh 折叠 max", xhigh.reasoning_effort === "max", json(xhigh));
	ok("max 发送 max", max.reasoning_effort === "max", json(max));
}

console.log("Kimi / Qwen / OpenAI wire 参数：");
{
	const kimi = model("custom", "kimi-k3");
	const low = await capture(kimi, "low");
	const max = await capture(kimi, "max");
	ok("Kimi low 用顶层 reasoning_effort", low.reasoning_effort === "low" && low.thinking === undefined, json(low));
	ok("Kimi max 用顶层 reasoning_effort", max.reasoning_effort === "max" && max.thinking === undefined, json(max));

	const qwen = model("custom", "qwen3.8-max");
	const medium = await capture(qwen, "medium");
	const xhigh = await capture(qwen, "xhigh");
	ok("Qwen medium 启用 thinking 并发送 medium", medium.enable_thinking === true && medium.reasoning_effort === "medium", json(medium));
	ok("Qwen xhigh 启用 thinking 并发送 xhigh", xhigh.enable_thinking === true && xhigh.reasoning_effort === "xhigh", json(xhigh));

	const gpt = model("custom", "gpt-5.6-sol");
	const off = await capture(gpt, "off");
	const gptMax = await capture(gpt, "max");
	ok("GPT off 映射 none", off.reasoning_effort === "none", json(off));
	ok("GPT max 发送 max", gptMax.reasoning_effort === "max", json(gptMax));
}

console.log(failures === 0 ? "\nREASONING PAYLOAD CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
