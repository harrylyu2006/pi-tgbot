/**
 * An ExtensionUIContext backed by Telegram.
 *
 * Extensions written for the TUI ask questions through `ctx.ui.confirm` and
 * degrade to fail-closed when `hasUI` is false. Supplying this object makes
 * `hasUI` true and routes those questions to the operator's phone instead, so
 * a safety extension can guard dangerous commands *without* removing the
 * operator's ability to say yes — which is the whole point of having chosen
 * full tool access.
 *
 * Every dialog is fail-closed on timeout: no answer means no.
 */

import { esc } from "../telegram/html.ts";
import { encodeCallback, keyboard, grid, type Button } from "../telegram/keyboard.ts";
import { errFields, type Logger } from "../log.ts";
import type { TelegramApi } from "../telegram/api.ts";
import { Theme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
	resolve: (value: string | undefined) => void;
	timer: NodeJS.Timeout;
	messageId: number;
	chatId: number;
	label: string;
}

export interface TelegramUIDeps {
	api: TelegramApi;
	log: Logger;
	bootId: string;
	/** Chat of the turn currently running; dialogs outside a turn are refused. */
	currentChatId: () => number | null;
	generation: () => number;
	timeoutMs?: number;
}

export class TelegramUI implements ExtensionUIContext {
	private readonly deps: TelegramUIDeps;
	private readonly pending = new Map<string, Pending>();
	private counter = 0;
	/** TUI styling is meaningless over Telegram, but the interface demands one; nothing ever renders it. */
	private readonly themeValue = {} as Theme;

	get theme(): Theme {
		return this.themeValue;
	}

	constructor(deps: TelegramUIDeps) {
		this.deps = deps;
	}

	/** Called by the callback router: `arg` is "<id>:<choiceIndex>". */
	resolve(arg: string): { ok: boolean; label: string } {
		const sep = arg.lastIndexOf(":");
		const id = sep >= 0 ? arg.slice(0, sep) : arg;
		const choice = sep >= 0 ? arg.slice(sep + 1) : "";
		const entry = this.pending.get(id);
		if (!entry) return { ok: false, label: "" };
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve(choice);
		return { ok: true, label: entry.label };
	}

	private async ask(title: string, message: string, options: string[], timeoutMs?: number): Promise<string | undefined> {
		const chatId = this.deps.currentChatId();
		if (chatId === null) {
			this.deps.log.warn({ msg: "ui dialog requested outside a turn, denying", title });
			return undefined;
		}
		const id = String(++this.counter);
		const buttons: Button[] = options.map((label, index) => ({
			text: label,
			data: encodeCallback("cf", `${id}:${index}`, this.deps.bootId, this.deps.generation()),
		}));

		const text = `<b>❓ ${esc(title)}</b>\n\n<pre>${esc(message.slice(0, 1500))}</pre>`;
		let messageId: number;
		try {
			const sent = await this.deps.api.sendMessage({
				chat_id: chatId,
				text,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				reply_markup: keyboard(grid(buttons, 2)),
			});
			messageId = sent.message_id;
		} catch (err) {
			// If we cannot ask, we must not proceed as though the answer were yes.
			this.deps.log.warn({ msg: "failed to send ui dialog, denying", ...errFields(err) });
			return undefined;
		}

		return new Promise<string | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.deps.log.info({ msg: "ui dialog timed out, denying", title });
				void this.deps.api
					.editMessageText({ chat_id: chatId, message_id: messageId, text: `${text}\n\n<i>⏱ 超时未响应，已拒绝</i>`, parse_mode: "HTML" })
					.catch(() => undefined);
				resolve(undefined);
			}, timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			// Not unref'd: a pending safety confirmation is load-bearing work. An
			// unref'd timer would let the process exit with the question unanswered,
			// which is the same class of bug as the poller's backoff sleep.
			this.pending.set(id, { resolve, timer, messageId, chatId, label: title });
		}).then((choice) => {
			if (choice !== undefined) {
				const picked = options[Number(choice)] ?? "?";
				void this.deps.api
					.editMessageText({ chat_id: chatId, message_id: messageId, text: `${text}\n\n<i>✅ 你选了：${esc(picked)}</i>`, parse_mode: "HTML" })
					.catch(() => undefined);
			}
			return choice;
		});
	}

	async confirm(title: string, message: string): Promise<boolean> {
		const choice = await this.ask(title, message, ["✅ 允许", "❌ 拒绝"]);
		return choice === "0";
	}

	async select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined> {
		const choice = await this.ask(title, "", options.slice(0, 8), opts?.timeout);
		return choice === undefined ? undefined : options[Number(choice)];
	}

	/** No text-entry dialog over Telegram in v1; extensions must handle undefined. */
	async input(): Promise<string | undefined> {
		return undefined;
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const chatId = this.deps.currentChatId();
		if (chatId === null) return;
		const icon = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
		void this.deps.api.sendMessage({ chat_id: chatId, text: `${icon} ${message}`.slice(0, 3800) }).catch(() => undefined);
	}

	/** The rest of ExtensionUIContext is terminal chrome with no Telegram analogue. */
	onTerminalInput(): () => void {
		return () => {};
	}
	setStatus(): void {}
	setWorkingMessage(): void {}
	setWorkingVisible(): void {}
	setWorkingIndicator(): void {}
	setHiddenThinkingLabel(): void {}
	setWidget(): void {}
	setFooter(): void {}
	setHeader(): void {}
	setTitle(): void {}
	/** No terminal chrome over Telegram; extensions get undefined and must handle it. */
	async custom<T>(): Promise<T> {
		return undefined as T;
	}
	pasteToEditor(): void {}

	/** TUI-only surface used by pi-subagents; safe no-ops for headless Telegram. */
	setToolsExpanded(): void {}
	getToolsExpanded(): boolean {
		return false;
	}
	setEditorText(): void {}
	getEditorText(): string {
		return "";
	}
	/** No editor over Telegram — subagents admin flows that open an editor degrade to fail-closed. */
	async editor(): Promise<string | undefined> {
		return undefined;
	}
	addAutocompleteProvider(): void {}
	setEditorComponent(): void {}
	getEditorComponent(): undefined {
		return undefined;
	}
	getAllThemes(): { name: string; path: string | undefined }[] {
		return [];
	}
	getTheme(): Theme | undefined {
		return undefined;
	}
	setTheme(): { success: boolean; error?: string } {
		return { success: false, error: "Telegram 无 TUI，不支持换主题" };
	}
}
