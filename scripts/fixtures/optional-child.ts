// Child process for optional-plugin-check.ts. Usage: node --import ./trace-resolve.mjs optional-child.ts <mode>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
const out: Record<string, unknown> = { mode };
if (mode === "core") {
	// everything the daemon imports at startup when `secrets` is not configured
	const { loadConfig } = await import("../../src/config.ts");
	await import("../../src/telegram/commands.ts");
	await import("../../src/telegram/redact.ts");
	await import("../../src/ui/telegram-ui.ts");
	out.loaded = typeof loadConfig === "function";
} else {
	const root = mkdtempSync(join(tmpdir(), "optional-child-"));
	const logs: string[] = [];
	const log: any = { info() {}, warn() {}, debug() {}, error: (o: any) => { logs.push(String(o.msg)); }, child() { return this; } };
	const { loadSecretsPlugin } = await import("../../src/secrets/plugin.ts");
	const keepass = mode === "plugin-keepass" || mode === "plugin-keepass-blocked"
		? { path: join(root, "kp", "main.kdbx"), mode: "session" as const, storedSecret: "keepass-master", idleMinutes: 30, maxHours: 8, hiddenTag: "h", confirmTag: "c", hiddenGroups: [], confirmGroups: [], maxFileMb: 64, maxArgonMiB: 256, maxEntriesPerSession: 8 }
		: undefined;
	const plugin = await loadSecretsPlugin({
		config: { baseUrl: "https://vault.test", host: "127.0.0.1", port: 0, dir: join(root, "v"), keyPath: join(root, "k", "vault.key"), linkTtlSeconds: 120, denyPlaceholderTools: [], auditPath: join(root, "audit.jsonl"), ...(keepass ? { keepass } : {}) },
		api: { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => true, call: async () => true } as any,
		ui: { confirm: async () => true } as any, log, operatorChatId: 1, currentChatId: () => 1, notifyAgent: () => {},
	});
	plugin.service.vault.set("probe", "probe-value-123456", {});
	out.hasKeepass = plugin.hasKeepass;
	out.keepassObject = plugin.service.keepass !== null;
	out.vaultWorks = plugin.service.vault.get("probe") === "probe-value-123456";
	out.logs = logs;
}
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
