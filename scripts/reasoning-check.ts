import {
	availableLevelsFor,
	enrichThinkingLevels,
	preferredDefaultThinkingLevelFor,
	type ModelLike,
	type ThinkingLevelMap,
} from "../src/agent/reasoning.ts";

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
function enriched(model: ModelLike): ModelLike {
	return enrichThinkingLevels(model);
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
	const result = enrichThinkingLevels(withMap);
	ok("已有 map 时原对象原样返回", result === withMap);
	ok("已有 map 的等级集不被改写", levels(result) === JSON.stringify(["minimal", "low", "medium", "high"]));
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
		["custom/DeepSeek-V4-Flash", { provider: "custom", id: "DeepSeek-V4-Flash", reasoning: true }, JSON.stringify(["off", "high", "max"]), "deepseek"],
		["custom/deepseek-v4-flash-0731", { provider: "custom", id: "deepseek-v4-flash-0731", reasoning: true }, JSON.stringify(["off", "high", "max"]), "deepseek"],
		["custom/GLM-5.2", { provider: "custom", id: "GLM-5.2", reasoning: true }, JSON.stringify(["off", "high", "max"]), "zai"],
		["custom/glm-5.2", { provider: "custom", id: "glm-5.2", reasoning: true }, JSON.stringify(["off", "high", "max"]), "zai"],
		["custom/kimi-k3", { provider: "custom", id: "kimi-k3", reasoning: true }, JSON.stringify(["low", "high", "max"]), "openai"],
		["custom/qwen3.8-max", { provider: "custom", id: "qwen3.8-max", reasoning: true }, JSON.stringify(["low", "medium", "xhigh"]), "qwen"],
	];
	for (const [spec, model, expected, format] of cases) {
		const result = enrichThinkingLevels(model);
		ok(`${spec} 等级 = ${expected}`, levels(result) === expected, levels(result));
		if (format) ok(`${spec} 使用 ${format} 请求格式`, result.compat?.thinkingFormat === format);
	}
}

console.log("DeepSeek V4 provider 分流：");
{
	const native = enriched({ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true });
	ok("原生 DeepSeek = off/high/max", levels(native) === JSON.stringify(["off", "high", "max"]), levels(native));
	ok("原生 low/minimal/medium/xhigh 隐藏", mapOf(native).low === null && mapOf(native).minimal === null && mapOf(native).medium === null && mapOf(native).xhigh === null);
	ok("原生 max 直传", mapOf(native).max === "max");
	ok("原生使用 DeepSeek thinking 格式", native.compat?.thinkingFormat === "deepseek");

	const routed = enriched({ provider: "openrouter", id: "deepseek/deepseek-v4-flash", reasoning: true });
	ok("OpenRouter DeepSeek = off/high/xhigh", levels(routed) === JSON.stringify(["off", "high", "xhigh"]), levels(routed));
	ok("OpenRouter xhigh 不折叠", mapOf(routed).xhigh === "xhigh");
	ok("OpenRouter 不开放 max", mapOf(routed).max === null);
	ok("OpenRouter 使用 nested reasoning 格式", routed.compat?.thinkingFormat === "openrouter");
}

console.log("GPT-5.6 / GPT-5.2~5.5：");
{
	const g56 = enriched({ provider: "custom", id: "gpt-5.6-sol", reasoning: true });
	ok("GPT-5.6 不含 minimal", !availableLevelsFor(g56).includes("minimal"));
	ok("GPT-5.6 off 映射 wire none", mapOf(g56).off === "none");
	ok("GPT-5.6 到 max", availableLevelsFor(g56).includes("max"));
	for (const version of ["gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5"]) {
		const model = enriched({ provider: "openai", id: version, reasoning: true });
		ok(`${version} = off/low/medium/high/xhigh`, levels(model) === JSON.stringify(["off", "low", "medium", "high", "xhigh"]), levels(model));
		ok(`${version} off 映射 wire none`, mapOf(model).off === "none");
	}
	const g55pro = enriched({ provider: "openai", id: "gpt-5.5-pro", reasoning: true });
	ok("GPT-5.5 Pro 仅 medium/high/xhigh", levels(g55pro) === JSON.stringify(["medium", "high", "xhigh"]), levels(g55pro));
}

console.log("Claude 精确家族：");
{
	const opus45 = enriched({ provider: "anthropic", id: "claude-opus-4-5-20251101", reasoning: true });
	ok("Claude Opus 4.5 保持 budget 标准等级", levels(opus45) === STANDARD, levels(opus45));
	const opus46 = enriched({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-6", reasoning: true });
	ok("Claude Opus 4.6 = off/low/medium/high/max", levels(opus46) === JSON.stringify(["off", "low", "medium", "high", "max"]), levels(opus46));
	ok("Claude 4.6 启用 adaptive thinking compat", opus46.compat?.forceAdaptiveThinking === true);
	ok("Claude 4.6 adaptive 模型禁用 temperature", opus46.compat?.supportsTemperature === false);
	const sonnet46 = enriched({ provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true });
	ok("Claude Sonnet 4.6 = off/low/medium/high/max", levels(sonnet46) === JSON.stringify(["off", "low", "medium", "high", "max"]), levels(sonnet46));
	const opus48 = enriched({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true });
	ok("Claude Opus 4.8 = off/low/medium/high/xhigh/max", levels(opus48) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]), levels(opus48));
	for (const id of ["claude-opus-5", "claude-sonnet-5"]) {
		const model = enriched({ provider: "anthropic", id, reasoning: true });
		ok(`${id} 可关闭且到 max`, levels(model) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]), levels(model));
	}
	for (const id of ["claude-fable-5", "claude-mythos-5"]) {
		const model = enriched({ provider: "anthropic", api: "anthropic-messages", id, reasoning: true });
		ok(`${id} 始终思考`, levels(model) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]), levels(model));
	}
	const unrelated = enriched({ provider: "custom", id: "claude-random-5", reasoning: true });
	ok("未知 Claude 5 名称不被宽泛误命中", levels(unrelated) === STANDARD, levels(unrelated));
}

console.log("GLM / Kimi / Qwen / Gemini / xAI：");
{
	const glm = enriched({ provider: "custom", id: "glm-5.2", reasoning: true });
	ok("GLM-5.2 UI 只显示三种真实行为", levels(glm) === JSON.stringify(["off", "high", "max"]), levels(glm));
	ok("GLM-5.2 off/high/max wire 映射正确", mapOf(glm).off === "none" && mapOf(glm).high === "high" && mapOf(glm).max === "max");

	const kimi = enriched({ provider: "custom", id: "kimi-k3", reasoning: true });
	ok("Kimi K3 = low/high/max", levels(kimi) === JSON.stringify(["low", "high", "max"]), levels(kimi));
	ok("Kimi K3 强制 OpenAI effort 格式", kimi.compat?.thinkingFormat === "openai" && kimi.compat?.supportsReasoningEffort === true);
	ok("Kimi K3 保留 reasoning content / deferred tools 兼容", kimi.compat?.requiresReasoningContentOnAssistantMessages === true && kimi.compat?.deferredToolsMode === "kimi");

	const qwen = enriched({ provider: "custom", id: "qwen3.8-max", reasoning: true });
	ok("Qwen3.8 Max = low/medium/xhigh", levels(qwen) === JSON.stringify(["low", "medium", "xhigh"]), levels(qwen));
	ok("Qwen3.8 Max 使用 qwen effort 格式", qwen.compat?.thinkingFormat === "qwen" && qwen.compat?.supportsReasoningEffort === true);

	const gemini = enriched({ provider: "google", id: "gemini-3.6-pro", reasoning: true });
	ok("Gemini 3.6 仅 minimal/low/medium/high", levels(gemini) === JSON.stringify(["minimal", "low", "medium", "high"]), levels(gemini));
	const grok = enriched({ provider: "xai", id: "grok-4.20", reasoning: true });
	ok("xAI Grok = low/medium/high", levels(grok) === JSON.stringify(["low", "medium", "high"]), levels(grok));
	const grokMulti = enriched({ provider: "xai", id: "grok-4.20-multi-agent", reasoning: true });
	ok("Grok 4.20 Multi Agent 额外支持 xhigh", levels(grokMulti) === JSON.stringify(["low", "medium", "high", "xhigh"]), levels(grokMulti));
}

console.log("模型原生默认档：");
{
	ok("Qwen3.8 Max 默认 xhigh", preferredDefaultThinkingLevelFor({ provider: "custom", id: "qwen3.8-max", reasoning: true }) === "xhigh");
	ok("其他模型不覆盖 Pi/用户默认", preferredDefaultThinkingLevelFor({ provider: "custom", id: "gpt-5.6-sol", reasoning: true }) === undefined);
}

console.log("缺键与 null 语义：");
{
	const unknown = enriched({ provider: "custom", id: "future-reasoner", reasoning: true });
	ok("未知模型不凭空补 xhigh/max", levels(unknown) === STANDARD, levels(unknown));
	const sparse: ModelLike = { provider: "custom", id: "sparse", reasoning: true, thinkingLevelMap: { max: "max" } };
	ok("缺键仍按 SDK fallback 暴露标准档", levels(sparse) === JSON.stringify(["off", "minimal", "low", "medium", "high", "max"]), levels(sparse));
	const hidden: ModelLike = { provider: "custom", id: "hidden", reasoning: true, thinkingLevelMap: { off: null, minimal: null, max: "max" } };
	ok("只有显式 null 才隐藏标准档", levels(hidden) === JSON.stringify(["low", "medium", "high", "max"]), levels(hidden));
}

console.log(failures === 0 ? "\nREASONING CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
