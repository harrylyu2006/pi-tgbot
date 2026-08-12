/**
 * Model-aware reasoning choices.
 *
 * The SDK derives `session.getAvailableThinkingLevels()` from the model's
 * `thinkingLevelMap` and, when the map is missing, falls back to a generic
 * set for any model flagged `reasoning` (standard levels through "high";
 * "xhigh"/"max" only appear when the map names them). Custom/provider models
 * rarely carry a map, so the panel would show thinking levels the endpoint
 * cannot actually serve — aliases on a DeepSeek V4 endpoint that only exposes
 * off/high/max, or no "xhigh"/"max" on a GPT-5.6 that accepts them.
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
	api?: unknown;
	baseUrl?: unknown;
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
	const routedThroughOpenRouter = provider === "openrouter" || compact(model.baseUrl).includes("openrouterai");
	const directAnthropicMessages = provider === "anthropic" || compact(model.api) === "anthropicmessages";
	const adaptiveClaudeCompat = directAnthropicMessages ? { forceAdaptiveThinking: true, supportsTemperature: false } : undefined;

	// DeepSeek V4 is provider-sensitive. Native/compatible DeepSeek endpoints
	// expose off/high/max and use the DeepSeek thinking object. OpenRouter has
	// its own normalized reasoning object and currently exposes off/high/xhigh.
	if (idName.includes("deepseek") && /v4/.test(idName) && /(flash|pro)/.test(idName)) {
		if (routedThroughOpenRouter) {
			return {
				map: { minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null },
				compat: { thinkingFormat: "openrouter" },
			};
		}
		return {
			map: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
			compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
		};
	}

	// GPT-5.6 officially supports none/low/medium/high/xhigh/max. It does not
	// support the older GPT-5 "minimal" label. Pi's "off" maps to wire "none".
	//
	// The Codex endpoint is narrower than the model: its request schema validates
	// reasoning_effort against low|medium|high|xhigh and 400s on "max", so every
	// turn fails while the panel keeps offering the level. Model capability and
	// endpoint capability are separate facts and are kept separate here.
	if (/gpt56/.test(idName)) {
		const codexEndpoint = provider === "codex" || compact(model.baseUrl).includes("backendapi");
		// Explicit on both branches: an absent key falls back to the SDK default
		// rather than preserving "max", so it must be written either way.
		return { map: { off: "none", minimal: null, xhigh: "xhigh", max: codexEndpoint ? null : "max" } };
	}
	// GPT-5.2 through 5.5 support none/low/medium/high/xhigh, again no minimal.
	// GPT-5.5 Pro is narrower: medium/high/xhigh only.
	if (/gpt55pro/.test(idName)) {
		return { map: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: null } };
	}
	if (/gpt5[2345]/.test(idName)) return { map: { off: "none", minimal: null, xhigh: "xhigh" } };

	// Claude rules use explicit API-id families, not a broad "claude ... 5"
	// substring. Opus/Sonnet 4.6 have max but not xhigh; Opus 4.7/4.8 and
	// Opus/Sonnet 5 add xhigh. Fable/Mythos 5 are always-thinking.
	const claudeOpus46 = /claudeopus46/.test(id);
	const claudeSonnet46 = /claudesonnet46/.test(id);
	const claudeOpus47or48 = /claudeopus4[78]/.test(id);
	const claudeOpusOrSonnet5 = /claude(?:opus|sonnet)5/.test(id);
	const claudeFableOrMythos5 = /claude(?:fable|mythos)5/.test(id);
	if (claudeOpus46 || claudeSonnet46) {
		return { map: { minimal: null, max: "max" }, ...(adaptiveClaudeCompat ? { compat: adaptiveClaudeCompat } : {}) };
	}
	if (claudeOpus47or48 || claudeOpusOrSonnet5) {
		return {
			map: { minimal: null, xhigh: "xhigh", max: "max" },
			...(adaptiveClaudeCompat ? { compat: adaptiveClaudeCompat } : {}),
		};
	}
	if (claudeFableOrMythos5) {
		return {
			map: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
			...(adaptiveClaudeCompat ? { compat: adaptiveClaudeCompat } : {}),
		};
	}

	// Gemini 3.5 / 3.6 reason unconditionally: off/xhigh/max are hidden, only
	// minimal/low/medium/high are offered.
	if (/gemini[^0-9]*3[56]/.test(idName)) return { map: { off: null, xhigh: null, max: null } };

	// xAI Grok reasoning cannot be disabled. Normal reasoning models expose
	// low/medium/high; grok-4.20-multi-agent additionally accepts xhigh to select
	// the larger agent team.
	if ((provider === "xai" || provider.includes("xai") || idName.includes("grok")) && model.reasoning === true) {
		if (/grok420multiagent/.test(idName)) {
			return { map: { off: null, minimal: null, xhigh: "xhigh", max: null } };
		}
		return { map: { off: null, minimal: null, xhigh: null, max: null } };
	}

	// GLM-5.2 has only two real on-states. Keep the UI truthful instead of
	// showing aliases that collapse to the same behavior: off/high/max.
	if (/glm52/.test(idName)) {
		return {
			map: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
			...(!routedThroughOpenRouter ? { compat: { thinkingFormat: "zai" } } : {}),
		};
	}

	// Kimi K3 always reasons and accepts low/high/max only. Its endpoint uses
	// OpenAI-style reasoning_effort, not Moonshot's older DeepSeek toggle.
	if (/kimik3/.test(idName)) {
		return {
			map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
			...(!routedThroughOpenRouter
				? {
						compat: {
							thinkingFormat: "openai",
							supportsReasoningEffort: true,
							requiresReasoningContentOnAssistantMessages: true,
							deferredToolsMode: "kimi",
						},
					}
				: {}),
		};
	}

	// Qwen3.8 Max always thinks and accepts low/medium/xhigh only.
	if (/qwen38max/.test(idName)) {
		return {
			map: { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
			...(!routedThroughOpenRouter ? { compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } } : {}),
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
 * Provider-native default that differs from Pi's generic `medium` default.
 * User-restored choices still take priority; this is only for a fresh profile.
 */
export function preferredDefaultThinkingLevelFor(model: ModelLike): ModelThinkingLevel | undefined {
	if (model.reasoning !== true) return undefined;
	return /qwen38max/.test(idAndName(model)) ? "xhigh" : undefined;
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
