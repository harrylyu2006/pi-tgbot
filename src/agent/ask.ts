/**
 * The `telegram_ask` tool: let the model put a real choice in front of the
 * operator instead of writing "请选 A/B/C/D" into a message with no buttons.
 *
 * Without this the model's only way to ask is prose, and the operator has to
 * type the answer as a new message — which also ends the turn, so the model
 * loses the working state it built up before asking. A tool keeps the question
 * inside the turn.
 *
 * The timeout is long (10 minutes, against the turn's 20-minute ceiling)
 * because this is a deliberate question to a human who may be away from their
 * phone, not a safety interlock that should fail fast.
 */

import type { TelegramUI } from "../ui/telegram-ui.ts";
import type { Logger } from "../log.ts";

export interface AskBinding {
	ui: TelegramUI;
	log: Logger;
}

export function createAskTool(binding: AskBinding): unknown {
	return {
		name: "telegram_ask",
		label: "Ask the operator",
		description:
			"Ask the operator a multiple-choice question and wait for their answer, rendered as tappable buttons in Telegram. " +
			"Use this whenever you would otherwise write 'choose A/B/C/D' in a message. " +
			"Returns the option text the operator picked, or a timeout notice. Max 8 options, keep each under 30 characters.",
		promptSnippet: "telegram_ask — put a multiple-choice question to the operator as tappable buttons",
		promptGuidelines: [
			"When you need the operator to choose between options, call telegram_ask instead of describing the options in prose.",
		],
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question, one short line" },
				options: {
					type: "array",
					items: { type: "string" },
					description: "2-8 short choices. Include an explicit 'cancel'-style option when the action is consequential.",
				},
			},
			required: ["question", "options"],
			additionalProperties: false,
		},
		async execute(_id: string, params: { question: string; options: string[] }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
			const options = (params.options ?? []).filter((o) => typeof o === "string" && o.trim()).slice(0, 8);
			if (options.length < 2) {
				return { content: [{ type: "text", text: "telegram_ask needs at least 2 options." }], isError: true };
			}
			const picked = await binding.ui.select(params.question, options, { timeout: 600_000 });
			binding.log.info({ msg: "telegram_ask", options: options.length, answered: picked !== undefined });
			const text = picked === undefined
				? "操作员没有在 10 分钟内选择。不要替他做决定，改为在回复里说明需要他确认什么。"
				: `操作员选择了：${picked}`;
			return { content: [{ type: "text", text }] };
		},
	};
}
