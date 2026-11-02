/**
 * Entry point of the optional "secrets" plugin (encrypted input page + vault, and — when `secrets.keepass` is set — read-only
 * KeePass access). The daemon imports this file only when `config.secrets` exists, so a deployment that does not use the
 * feature never loads any of its code, opens no listener, registers no tools or commands, and does not need `kdbxweb`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../log.ts";
import type { TelegramApi } from "../telegram/api.ts";
import { addOutboundRedactor } from "../telegram/redact.ts";
import type { TelegramUI } from "../ui/telegram-ui.ts";
import { createSecretsExtension } from "./extension.ts";
import { SecretsService, savedNotice, unlockedNotice, type SecretsConfig } from "./service.ts";

export interface SecretsPluginDeps {
	config: SecretsConfig;
	api: TelegramApi;
	ui: TelegramUI;
	log: Logger;
	/** Private-chat id of the single operator. */
	operatorChatId: number;
	/** Chat of the turn currently running, if any. */
	currentChatId: () => number | null;
	/**
	 * Hand the agent a system notice (a prompt that is steered into the running turn or starts one). The text never contains
	 * a secret value; it names what was stored or unlocked.
	 */
	notifyAgent: (text: string, chatId: number, replyTo: number) => void;
}

export interface SecretsPlugin {
	service: SecretsService;
	/** In-process pi extension that registers the secret_* / keepass_* tools and the substitution and scrubbing hooks. */
	extensionFactory: (pi: ExtensionAPI) => void;
	hasKeepass: boolean;
}

export async function loadSecretsPlugin(deps: SecretsPluginDeps): Promise<SecretsPlugin> {
	const service = await SecretsService.create({
		config: deps.config, api: deps.api, ui: deps.ui, log: deps.log, operatorChatId: deps.operatorChatId, currentChatId: deps.currentChatId,
		onSaved: (e) => deps.notifyAgent(savedNotice(e), e.chatId, e.messageId),
		onUnlocked: (e) => deps.notifyAgent(unlockedNotice(e), e.chatId, e.messageId),
	});
	addOutboundRedactor(service.scrubText);
	return { service, extensionFactory: createSecretsExtension(service), hasKeepass: service.keepass !== null };
}
