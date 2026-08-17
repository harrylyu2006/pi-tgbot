import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = mkdtempSync(join(tmpdir(), "pi-tgbot-email-agent-"));
const sessionDir = mkdtempSync(join(tmpdir(), "pi-tgbot-email-session-"));
const emailPath = fileURLToPath(new URL("../vendor/pi-email", import.meta.url));

let session: any;
try {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [emailPath],
	});
	await loader.reload();

	const loaded = loader.getExtensions();
	const paths = (loaded.extensions ?? []).map((entry: any) => String(entry.resolvedPath ?? entry.path));
	if (!paths.some((path: string) => path.includes("vendor/pi-email"))) {
		throw new Error(`vendored pi-email did not load: ${JSON.stringify({ paths, errors: loaded.errors ?? [] })}`);
	}

	const created = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, sessionDir),
		excludeTools: [],
	});
	session = created.session;
	await session.bindExtensions({ abortHandler: () => {} });

	const registered = new Set(session.getAllTools().map((tool: { name: string }) => tool.name));
	const expected = [
		"email_setup",
		"email_status",
		"email_list_mailboxes",
		"email_fetch",
		"email_read",
		"email_search",
		"email_send",
		"email_reply",
		"email_forward",
		"email_delete",
		"email_move",
		"email_flag",
	];
	const missing = expected.filter((name) => !registered.has(name));
	if (missing.length > 0) throw new Error(`missing pi-email tools: ${missing.join(", ")}`);

	console.log(`Vendored pi-email loaded and registered ${expected.length} tools.`);
} finally {
	session?.dispose?.();
	rmSync(sessionDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
}
