import { streamSimple } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
import { enrichThinkingLevels, type ModelLike } from "../src/agent/reasoning.ts";

interface AnthropicPayloadModel extends ModelLike {
	id: string;
	provider: "anthropic";
	api: "anthropic-messages";
	baseUrl: string;
	input: ["text"];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface AnthropicPayload {
	thinking?: { type: string; display?: string };
	output_config?: { effort?: string };
}

let failures = 0;
function ok(name: string, cond: boolean, detail?: string): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : detail ? `\n      ${detail}` : ""}`);
}

function model(id: string): AnthropicPayloadModel {
	return enrichThinkingLevels({
		id,
		name: id,
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 32_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}) as AnthropicPayloadModel;
}

async function capture(modelValue: AnthropicPayloadModel, reasoning?: "low" | "medium" | "high" | "xhigh" | "max"): Promise<AnthropicPayload> {
	let payload: AnthropicPayload | undefined;
	const stream = streamSimple(
		modelValue as never,
		{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
		{
			apiKey: "not-a-real-key",
			...(reasoning ? { reasoning } : {}),
			onPayload: (params: unknown) => {
				payload = params as AnthropicPayload;
				throw new Error("payload captured");
			},
		},
	);
	await stream.result();
	if (!payload) throw new Error(`No payload captured for ${modelValue.id}`);
	return payload;
}

console.log("Claude off / adaptive payload：");
{
	const opus = model("claude-opus-5");
	const off = await capture(opus);
	ok("Opus 5 off 发送 thinking.disabled", JSON.stringify(off.thinking) === JSON.stringify({ type: "disabled" }), JSON.stringify(off));
	ok("Opus 5 off 不发送 effort=none", off.output_config === undefined, JSON.stringify(off));

	const xhigh = await capture(opus, "xhigh");
	ok("Opus 5 xhigh 使用 adaptive thinking", JSON.stringify(xhigh.thinking) === JSON.stringify({ type: "adaptive", display: "summarized" }), JSON.stringify(xhigh));
	ok("Opus 5 xhigh 只发送 effort=xhigh", JSON.stringify(xhigh.output_config) === JSON.stringify({ effort: "xhigh" }), JSON.stringify(xhigh));

	const fable = model("claude-fable-5");
	const fableOff = await capture(fable);
	ok("始终思考的 Fable 5 不发送 disabled", fableOff.thinking === undefined && fableOff.output_config === undefined, JSON.stringify(fableOff));
}

console.log(failures === 0 ? "\nANTHROPIC REASONING PAYLOAD CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
