/**
 * Anthropic 5.5 thinking signatures are bound to the preceding conversation,
 * including system instructions and tool definitions. A resumed Pi session may
 * legitimately change that prefix (AGENTS.md, skills, active tools, compaction).
 * Ask the official API to drop only mismatched blocks instead of rejecting the
 * whole request. Never edit the persisted transcript or strip valid adaptive
 * thinking locally. Older models and third-party compatible endpoints are left
 * alone: they do not necessarily implement this beta.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

interface BindingModel {
	api?: unknown;
	id?: unknown;
	baseUrl?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function supportsThinkingBinding(model: BindingModel | undefined): boolean {
	if (model?.api !== "anthropic-messages" || typeof model.id !== "string" || typeof model.baseUrl !== "string") return false;
	try {
		const url = new URL(model.baseUrl);
		if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com" || url.port) return false;
	} catch {
		return false;
	}
	// Keep this opt-in to verified binding-capable families, including snapshots.
	return /^claude-(?:(?:opus|sonnet|haiku)-5-5|fable-5-1)(?:-|$)/.test(model.id.replaceAll(".", "-"));
}

/** Merge case-insensitively without losing other betas or unrelated headers. */
export function addThinkingBindingHeader(headers: Record<string, string | null | undefined>): void {
	const keys = Object.keys(headers).filter((key) => key.toLowerCase() === "anthropic-beta");
	const betas = new Set(keys.flatMap((key) => (headers[key] ?? "").split(",").map((beta) => beta.trim()).filter(Boolean)));
	betas.add(THINKING_BINDING_BETA);
	for (const key of keys) delete headers[key];
	headers["anthropic-beta"] = [...betas].join(",");
}

/** Pure request-only transform. Returns undefined when no change is needed. */
export function thinkingBindingPayload(payload: unknown): unknown | undefined {
	if (!record(payload)) return undefined;
	if (record(payload.thinking) && payload.thinking.type === "adaptive") {
		return {
			...payload,
			thinking: {
				...payload.thinking,
				block_binding: {
					...(record(payload.thinking.block_binding) ? payload.thinking.block_binding : {}),
					prefix_mismatch_behavior: "drop_block",
				},
			},
		};
	}

	// Sonnet 5.5's off-mode is between_tools, not disabled (the SDK predates
	// this distinction). Haiku 5.5 still accepts disabled and is left alone.
	const sonnetOff = record(payload.thinking) && payload.thinking.type === "disabled"
		&& /^claude-sonnet-5-5(?:-|$)/.test(String(payload.model).replaceAll(".", "-"));
	const base = sonnetOff ? { ...payload, thinking: { type: "between_tools" } } : payload;

	// block_binding is invalid alongside disabled/between_tools/manual thinking.
	// These modes cannot use the beta's drop policy. Omit historical thinking in
	// the outgoing request only, retaining text, tool calls/results, and images.
	if (!Array.isArray(payload.messages)) return sonnetOff ? base : undefined;
	let changed = sonnetOff;
	const messages = payload.messages.flatMap((message: unknown) => {
		if (!record(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [message];
		const content = message.content.filter((block: unknown) => !record(block) || !["thinking", "redacted_thinking"].includes(String(block.type)));
		if (content.length === message.content.length) return [message];
		changed = true;
		return content.length > 0 ? [{ ...message, content }] : [];
	});
	return changed ? { ...base, messages } : undefined;
}

/**
 * pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN checks `/billing/i` before
 * RETRYABLE_PROVIDER_ERROR_PATTERN. OpenAI's transient TPM/RPM 429 messages end
 * with a help link (`https://platform.openai.com/account/billing`), which trips
 * `/billing/i` and prevents AgentSession from auto-retrying a brief rate limit.
 * Rewrite only the `/account/billing` URL path on transient rate-limit errors,
 * leaving genuine quota/billing exhaustion untouched.
 */
export function normalizeTransientRateLimitMessage(errorMessage: unknown): string | undefined {
	if (typeof errorMessage !== "string" || !/\/account\/billing\b/i.test(errorMessage)) return undefined;
	if (!/\brate limit reached\b/i.test(errorMessage)) return undefined;
	if (/\b(?:insufficient_quota|exceeded your current quota|out of budget|quota exceeded)\b/i.test(errorMessage)) {
		return undefined;
	}
	return errorMessage.replace(/\/account\/billing\b/gi, "/account/rate-limits");
}

export default function anthropicThinkingBinding(pi: ExtensionAPI): void {
	pi.on("before_provider_headers", (event, ctx) => {
		if (supportsThinkingBinding(ctx.model) && ctx.thinkingLevel !== "off") addThinkingBindingHeader(event.headers);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (supportsThinkingBinding(ctx.model)) return thinkingBindingPayload(event.payload);
	});
	pi.on("message_end", (event) => {
		const message = event.message as unknown as Record<string, unknown>;
		if (message?.role !== "assistant" || message.stopReason !== "error") return;
		const normalized = normalizeTransientRateLimitMessage(message.errorMessage);
		if (!normalized) return;
		return { message: { ...event.message, errorMessage: normalized } };
	});
}
