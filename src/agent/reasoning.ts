/**
 * Model-aware reasoning choices.
 *
 * The SDK derives `session.getAvailableThinkingLevels()` from the model's
 * `thinkingLevelMap` and, when the map is missing, falls back to a generic
 * set for any model flagged `reasoning` (standard levels through "high";
 * "xhigh"/"max" only appear when the map names them). Custom/provider models
 * rarely carry a map, so the panel would show thinking levels the endpoint
 * cannot actually serve — "minimal"/"medium" on a DeepSeek V4 endpoint that
 * only understands off/low/high, or no "xhigh"/"max" on a GPT-5.6 that
 * accepts them.
 *
 * This module infers a map from normalized provider/id/name keywords and
 * attaches it to the model object before the model reaches the session, so
 * `getAvailableThinkingLevels()` and `setThinking` agree with what the
 * endpoint really supports. Metadata-first: an existing `thinkingLevelMap`
 * always wins. Anything the rules do not name keeps the SDK default (standard
 * levels through "high"); non-reasoning models stay "off" only, which the SDK
 * already produces and we leave untouched.
 */

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/** Everything the inference rules read off a model descriptor. */
export interface ModelLike {
	id?: unknown;
	name?: unknown;
	provider?: unknown;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
}

/** Lowercase, alphanumerics only: "gpt-5.6-codex" → "gpt56codex". */
function compact(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

/** The model family lives in the id/name; provider is a secondary hint. */
function idAndName(model: ModelLike): string {
	return `${compact(model.id)} ${compact(model.name)}`;
}

interface InferredThinking {
	map: ThinkingLevelMap;
	compat?: Record<string, unknown>;
}

function inferThinkingLevelMap(model: ModelLike): InferredThinking | undefined {
	const id = compact(model.id);
	const provider = compact(model.provider);
	const idName = idAndName(model);
	const customOpenAICompatible = provider !== "openrouter";

	// DeepSeek V4 Flash / Pro: OpenAI-compatible chat uses thinking.enabled /
	// thinking.disabled plus reasoning_effort low/high/max; xhigh is accepted
	// and folds into high. minimal/medium are not real DeepSeek modes.
	if ((idName.includes("deepseek") || provider.includes("deepseek")) && /v4/.test(idName) && /(flash|pro)/.test(idName)) {
		return {
			map: { minimal: null, medium: null, xhigh: "high", max: "max" },
			...(customOpenAICompatible
				? { compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true } }
				: {}),
		};
	}

	// GPT-5.6 officially supports none/low/medium/high/xhigh/max. It does not
	// support the older GPT-5 "minimal" label. Pi's "off" maps to wire "none".
	if (/gpt56/.test(idName)) return { map: { off: "none", minimal: null, xhigh: "xhigh", max: "max" } };
	// GPT-5.2 through 5.5 support none/low/medium/high/xhigh, again no minimal.
	if (/gpt5[2345]/.test(idName)) return { map: { off: "none", minimal: null, xhigh: "xhigh" } };

	// Claude adaptive effort has no "minimal" wire level; pi-ai folds minimal to
	// low, but showing a second low alias is misleading, so hide it.
	if (/claude[^0-9]*46/.test(id)) return { map: { minimal: null, max: "max" } };
	if (/claude[^0-9]*4[78]/.test(id)) return { map: { minimal: null, xhigh: "xhigh", max: "max" } };
	// Fable 5 adaptive thinking is always on; Opus/Sonnet 5 can still disable
	// thinking at high-or-below effort.
	if (/fable[^0-9]*5/.test(idName)) return { map: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
	if (/claude[^0-9]*5/.test(id)) return { map: { minimal: null, xhigh: "xhigh", max: "max" } };

	// Gemini 3.5 / 3.6 reason unconditionally: off/xhigh/max are hidden, only
	// minimal/low/medium/high are offered.
	if (/gemini[^0-9]*3[56]/.test(idName)) return { map: { off: null, xhigh: null, max: null } };

	// xAI Grok reasoning cannot be disabled; documented effort is low/medium/high.
	if ((provider === "xai" || provider.includes("xai") || idName.includes("grok")) && model.reasoning === true) {
		return { map: { off: null, minimal: null, xhigh: null, max: null } };
	}

	// GLM-5.2 accepts none/minimal/low/medium/high/xhigh/max. Z.ai maps low and
	// medium to high, and xhigh to max, but those aliases are documented wire
	// values. Pi's off maps to the documented "none" / disabled toggle.
	if (/glm52/.test(idName)) {
		return {
			map: { off: "none", xhigh: "xhigh", max: "max" },
			...(customOpenAICompatible ? { compat: { thinkingFormat: "zai" } } : {}),
		};
	}

	// Kimi K3 always reasons and accepts low/high/max only.
	if (/kimik3/.test(idName)) return { map: { off: null, minimal: null, medium: null, xhigh: null, max: "max" } };

	// Qwen3.8 Max always thinks and accepts low/medium/xhigh only.
	if (/qwen38max/.test(idName)) {
		return {
			map: { off: null, minimal: null, high: null, max: null, xhigh: "xhigh" },
			...(customOpenAICompatible ? { compat: { thinkingFormat: "qwen" } } : {}),
		};
	}

	// Other reasoning models keep the SDK standard (through "high").
	return undefined;
}

/**
 * Attach an inferred `thinkingLevelMap` when the model is reasoning-capable
 * and carries no explicit map. Returns the same object when nothing changes,
 * so callers can cheaply skip the write.
 */
export function enrichThinkingLevels<T extends ModelLike>(model: T): T {
	if (!model || typeof model !== "object") return model;
	if (model.thinkingLevelMap) return model; // metadata-first: an explicit map always wins
	if (model.reasoning !== true) return model; // SDK already yields ["off"]
	const inferred = inferThinkingLevelMap(model);
	if (!inferred) return model;
	return {
		...model,
		thinkingLevelMap: inferred.map,
		...(inferred.compat ? { compat: { ...(model.compat ?? {}), ...inferred.compat } } : {}),
	};
}

/**
 * Levels `session.getAvailableThinkingLevels()` reports for a model — mirrors
 * pi-ai's getSupportedThinkingLevels() so tests can assert the button set an
 * operator actually sees on the panel.
 */
export function availableLevelsFor(model: ModelLike): ModelThinkingLevel[] {
	if (model.reasoning !== true) return ["off"];
	const all: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return all.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false; // explicitly hidden
		if (level === "xhigh" || level === "max") return mapped !== undefined; // only exposed when named
		return true; // standard levels default to shown
	});
}
