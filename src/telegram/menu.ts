import type { TelegramApi } from "./api.ts";

export interface BotCommand { command: string; description: string }
const same = (a: BotCommand[], b: BotCommand[]): boolean => a.length === b.length && a.every((c, i) => c.command === b[i]?.command && c.description === b[i]?.description);

/** Telegram resolves chat > all_private_chats > default, with per-scope language
 * overrides before its fallback. Updating default alone does not replace an old
 * bot's private menu. Read/replace/verify, without deleting any command lists.
 */
export async function syncCommandMenu(api: TelegramApi, userId: number, commands: BotCommand[], signal?: AbortSignal, languages = ["", "en", "zh"]): Promise<void> {
	const scopes = [{ type: "chat", chat_id: userId }, { type: "all_private_chats" }, { type: "default" }];
	for (const scope of scopes) {
		for (const language_code of new Set(languages)) {
			if (signal?.aborted) throw signal.reason;
			const params = { scope, language_code };
			const before = await api.getMyCommands(params, signal);
			if (same(before, commands)) continue;
			if (!await api.setMyCommands(commands, signal, params)) throw new Error("Command menu update was not accepted");
			if (!same(await api.getMyCommands(params, signal), commands)) throw new Error("Command menu verification failed");
		}
	}
}
