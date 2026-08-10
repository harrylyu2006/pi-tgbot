/**
 * One error taxonomy for the whole process.
 *
 * Every layer classifies failures into these kinds so the supervisor can decide
 * policy in one place instead of each call site growing its own `instanceof`
 * ladder. The distinction that matters most: a 409 means someone else is
 * polling our bot token — that is *degraded*, not dead, because outbound
 * methods keep working. A 401 means the token is gone, which is terminal.
 */

export type ErrorKind =
	| "fatal" // unrecoverable: revoked token, bad config, lock held
	| "conflict" // 409: another getUpdates consumer or a webhook is set
	| "throttled" // 429: carries retry_after seconds
	| "transient" // 5xx, network, timeout — retry with backoff
	| "rejected"; // 4xx we caused: bad entities, message not modified

export class TgError extends Error {
	readonly kind: ErrorKind;
	readonly status: number | undefined;
	readonly description: string;
	readonly retryAfter: number | undefined;
	readonly method: string | undefined;

	constructor(
		kind: ErrorKind,
		message: string,
		opts?: { status?: number; description?: string; retryAfter?: number; method?: string; cause?: unknown },
	) {
		super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
		this.name = "TgError";
		this.kind = kind;
		this.status = opts?.status;
		this.description = opts?.description ?? message;
		this.retryAfter = opts?.retryAfter;
		this.method = opts?.method;
	}
}

/** True when the Bot API told us the edit was a no-op. Callers treat it as success. */
export function isNotModified(err: unknown): boolean {
	return err instanceof TgError && /message is not modified/i.test(err.description);
}

/** True when our HTML was structurally invalid — the caller must retry as plain text. */
export function isBadEntities(err: unknown): boolean {
	return err instanceof TgError && /can't parse entities|can not parse entities/i.test(err.description);
}

/**
 * Classify a Bot API JSON error body.
 *
 * The full `description` is preserved on purpose: Telegram distinguishes
 * "terminated by other getUpdates request" from "terminated by setWebhook"
 * only in that free-text field, and the two need different operator advice.
 */
export function classifyApiError(method: string, status: number, body: unknown): TgError {
	const desc =
		body && typeof body === "object" && typeof (body as { description?: unknown }).description === "string"
			? (body as { description: string }).description
			: `HTTP ${status}`;
	const retryAfter =
		body && typeof body === "object"
			? (body as { parameters?: { retry_after?: number } }).parameters?.retry_after
			: undefined;

	const base = { status, description: desc, method, retryAfter };

	if (status === 401 || status === 403) {
		return new TgError("fatal", `${method}: ${desc}`, base);
	}
	if (status === 409) {
		return new TgError("conflict", `${method}: ${desc}`, base);
	}
	if (status === 429) {
		return new TgError("throttled", `${method}: ${desc}`, base);
	}
	if (status >= 500) {
		return new TgError("transient", `${method}: ${desc}`, base);
	}
	return new TgError("rejected", `${method}: ${desc}`, base);
}

/** Network-level failures (DNS, reset, timeout) are always transient. */
export function classifyNetworkError(method: string, err: unknown): TgError {
	return new TgError("transient", `${method}: ${String(err)}`, { method, cause: err });
}
