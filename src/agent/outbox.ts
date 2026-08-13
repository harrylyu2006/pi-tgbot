/**
 * The `telegram_send_file` tool.
 *
 * A real tool rather than a magic marker in the answer text: when the path is
 * wrong or the file is too large, the failure comes back *inside the turn*, so
 * the model can correct itself instead of the operator seeing a confident
 * "已发送" for a file that never left the box.
 *
 * The chat to deliver to is bound per turn by the daemon, not chosen by the
 * model — the model has no business selecting a destination.
 */

import type { Files } from "../telegram/files.ts";
import type { Logger } from "../log.ts";

export interface OutboxBinding {
	/** Chat for the turn currently running, or null when idle. */
	currentChatId: () => number | null;
	files: Files;
	log: Logger;
}

/**
 * Built as a plain object rather than through `defineTool`.
 *
 * Two copies of typebox resolve in this tree (ours and the one nested under the
 * SDK), so the two `TSchema` brands are nominally different and `defineTool`
 * would reject a schema built with our copy. The runtime only ever reads the
 * schema as data, so a plain JSON-Schema object with one cast at the boundary
 * is both correct and less fragile than fighting the type identity.
 */
export function createSendFileTool(binding: OutboxBinding): unknown {
	return {
		name: "telegram_send_file",
		label: "Send file to Telegram",
		description:
			"Send a local file to the operator's Telegram chat. Use for artifacts you produced (reports, images, logs, archives). " +
			"Provide an absolute path. Images (.jpg/.jpeg/.png/.webp) are sent as photos, everything else as documents.",
		promptSnippet: "telegram_send_file — deliver a local file to the operator over Telegram",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path of the file to send" },
				caption: { type: "string", description: "Optional caption, max 1024 chars" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		async execute(_toolCallId: string, params: { path: string; caption?: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
			const chatId = binding.currentChatId();
			if (chatId === null) {
				return { content: [{ type: "text", text: "No active Telegram chat for this turn; cannot send." }], isError: true };
			}
			const result = await binding.files.send(chatId, params.path, params.caption);
			binding.log.info({ msg: "telegram_send_file", ok: result.ok });
			return result.ok
				? { content: [{ type: "text", text: result.detail }] }
				: { content: [{ type: "text", text: result.detail }], isError: true };
		},
	};
}
