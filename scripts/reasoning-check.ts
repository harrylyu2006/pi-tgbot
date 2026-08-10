import { availableLevelsFor, enrichThinkingLevels, type ModelLike, type ThinkingLevelMap } from "../src/agent/reasoning.ts";

let failures = 0;
function ok(name: string, cond: boolean, detail?: string): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : detail ? `\n      ${detail}` : ""}`);
}
function levels(model: ModelLike): string {
	return JSON.stringify(availableLevelsFor(model));
}
function mapOf(model: ModelLike): ThinkingLevelMap {
	return model.thinkingLevelMap ?? {};
}
const STANDARD = JSON.stringify(["off", "minimal", "low", "medium", "high"]);

console.log("元数据优先（已有 map 一律赢）：");
{
	const withMap: ModelLike = {
		provider: "custom",
		id: "gpt-5.6",
		reasoning: true,
		thinkingLevelMap: { off: null } satisfies ThinkingLevelMap,
	};
	const r = enrichThinkingLevels(withMap);
	ok("已有 map 时原对象原样返回", r === withMap);
	ok("已有 map 的等级集不被改写", levels(r) === JSON.stringify(["minimal", "low", "medium", "high"]));
}

console.log("非推理模型保持 off only：");
{
	const plain: ModelLike = { provider: "x", id: "gpt-4o-mini", reasoning: false };
	ok("非推理模型不变（同一对象）", enrichThinkingLevels(plain) === plain);
	ok("非推理模型仅 off", levels(plain) === JSON.stringify(["off"]));
}

console.log("当前自定义模型矩阵：");
{
	const cases: Array<[string, ModelLike, string, string | undefined]> = [
		["custom/gpt-5.6-sol", { provider: "custom", id: "gpt-5.6-sol", reasoning: true }, JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]), undefined],
		["custom/gpt-5.6-luna", { provider: "custom", id: "gpt-5.6-luna", reasoning: true }, JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]), undefined],
		["custom/DeepSeek-V4-Flash", { provider: "custom", id: "DeepSeek-V4-Flash", reasoning: true }, JSON.stringify(["off", "low", "high", "xhigh", "max"]), "deepseek"],
		["custom/deepseek-v4-flash-0731", { provider: "custom", id: "deepseek-v4-flash-0731", reasoning: true }, JSON.stringify(["off", "low", "high", "xhigh", "max"]), "deepseek"],
		["custom/GLM-5.2", { provider: "custom", id: "GLM-5.2", reasoning: true }, JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), "zai"],
		["custom/GLM-5.2", { provider: "custom", id: "GLM-5.2", reasoning: true }, JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), "zai"],
		["custom/glm-5.2", { provider: "custom", id: "glm-5.2", reasoning: true }, JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), "zai"],
		["custom/kimi-k3", { provider: "custom", id: "kimi-k3", reasoning: true }, JSON.stringify(["low", "high", "max"]), undefined],
		["custom/qwen3.8-max", { provider: "custom", id: "qwen3.8-max", reasoning: true }, JSON.stringify(["low", "medium", "xhigh"]), "qwen"],
	];
	for (const [spec, model, expected, format] of cases) {
		const enriched = enrichThinkingLevels(model);
		ok(`${spec} 等级 = ${expected}`, levels(enriched) === expected, levels(enriched));
		if (format) ok(`${spec} 使用 ${format} 请求格式`, enriched.compat?.thinkingFormat === format);
	}
}

console.log("DeepSeek V4 Flash/Pro：");
{
	const dsModel: ModelLike = { provider: "custom", id: "deepseek-v4-flash-0731", reasoning: true };
	const ds = enrichThinkingLevels(dsModel);
	const map = mapOf(ds);
	ok("minimal/medium 被隐藏", map.minimal === null && map.medium === null);
	ok("xhigh 折叠到 high", map.xhigh === "high");
	ok("max 可用", map.max === "max");
	ok("off 通过 DeepSeek thinking toggle 关闭", ds.compat?.thinkingFormat === "deepseek");
	ok("provider=deepseek 的 V4 Pro 同样命中", levels(enrichThinkingLevels({ provider: "deepseek", id: "deepseek-v4-pro", reasoning: true })) === JSON.stringify(["off", "low", "high", "xhigh", "max"]));
}

console.log("GPT-5.6 / GPT-5.2~5.5：");
{
	const g56 = enrichThinkingLevels({ provider: "custom", id: "gpt-5.6-sol", reasoning: true });
	ok("GPT-5.6 不含 minimal", !availableLevelsFor(g56).includes("minimal"));
	ok("GPT-5.6 off 映射 wire none", mapOf(g56).off === "none");
	ok("GPT-5.6 到 max", availableLevelsFor(g56).includes("max"));
	for (const v of ["gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5"]) {
		const m = enrichThinkingLevels({ provider: "openai", id: v, reasoning: true });
		ok(`${v} = off/low/medium/high/xhigh`, levels(m) === JSON.stringify(["off", "low", "medium", "high", "xhigh"]), levels(m));
		ok(`${v} off 映射 wire none`, mapOf(m).off === "none");
	}
}

console.log("Claude：");
{
	const c46 = enrichThinkingLevels({ provider: "anthropic", id: "claude-opus-4-6", reasoning: true });
	ok("Claude 4.6 = off/low/medium/high/max", levels(c46) === JSON.stringify(["off", "low", "medium", "high", "max"]));
	const c48 = enrichThinkingLevels({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true });
	ok("Claude 4.8 = off/low/medium/high/xhigh/max", levels(c48) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]));
	const c5 = enrichThinkingLevels({ provider: "anthropic", id: "claude-opus-5", reasoning: true });
	ok("Claude Opus 5 = off/low/medium/high/xhigh/max", levels(c5) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]));
	const f5 = enrichThinkingLevels({ provider: "anthropic", id: "claude-fable-5", reasoning: true });
	ok("Fable 5 推理不可关闭", !availableLevelsFor(f5).includes("off"));
	ok("Fable 5 = low/medium/high/xhigh/max", levels(f5) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]));
	const c45 = enrichThinkingLevels({ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true });
	ok("Claude 4.5 保持标准等级", levels(c45) === STANDARD);
}

console.log("Gemini / xAI：");
{
	const g36 = enrichThinkingLevels({ provider: "google", id: "gemini-3.6-pro", reasoning: true });
	ok("Gemini 3.6 仅 minimal/low/medium/high", levels(g36) === JSON.stringify(["minimal", "low", "medium", "high"]));
	const grok = enrichThinkingLevels({ provider: "xai", id: "grok-4.5", reasoning: true });
	ok("xAI Grok = low/medium/high", levels(grok) === JSON.stringify(["low", "medium", "high"]));
	const routed = enrichThinkingLevels({ provider: "openrouter", id: "x-ai/grok-4.3", reasoning: true });
	ok("OpenRouter 的 x-ai/grok 别名同样命中", levels(routed) === JSON.stringify(["low", "medium", "high"]));
}

console.log("大小写与分隔符不敏感：");
{
	const mixed = enrichThinkingLevels({ provider: "Custom", id: "DeepSeek-V4-Flash", reasoning: true });
	ok("DeepSeek-V4-Flash 命中", levels(mixed) === JSON.stringify(["off", "low", "high", "xhigh", "max"]));
	const dot = enrichThinkingLevels({ provider: "anthropic", id: "claude.4.6", reasoning: true });
	ok("claude.4.6 命中 max", availableLevelsFor(dot).includes("max"));
	const space = enrichThinkingLevels({ provider: "google", id: "gemini 3.6 pro", reasoning: true });
	ok("gemini 3.6 pro 命中", levels(space) === JSON.stringify(["minimal", "low", "medium", "high"]));
}

console.log(failures === 0 ? "\nREASONING CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
