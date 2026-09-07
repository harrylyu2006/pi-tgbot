/** Only command metadata is changed. Never starts polling or an agent session. */
import { loadConfig } from "../src/config.ts";
import { createLogger, errFields } from "../src/log.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import { COMMANDS } from "../src/telegram/commands.ts";
import { syncCommandMenu } from "../src/telegram/menu.ts";

const log = createLogger("menu-sync");
try {
	const config = loadConfig(process.argv[2] ?? process.env.PI_TG_CONFIG ?? "/etc/pi-tg/config.json");
	await syncCommandMenu(new TelegramApi(config.botToken, log), config.allowedUserId, COMMANDS, AbortSignal.timeout(180_000));
	console.log("Verified current commands for operator, all-private and default scopes (fallback/en/zh).");
} catch (err) {
	log.error({ msg: "menu sync failed", ...errFields(err) });
	process.exitCode = 1;
}
