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
const agentDir = process.env.PI_TG_TEST_AGENT_DIR ?? join(tmpdir(), "pi-tgbot-test-agent");
const sessionDir = mkdtempSync(join(tmpdir(), "pi-tgbot-web-access-"));
const webAccessPath = fileURLToPath(new URL("../node_modules/pi-web-access", import.meta.url));

let session: any;
try {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [webAccessPath],
	});
	await loader.reload();

	const loaded = loader.getExtensions();
	const paths = (loaded.extensions ?? []).map((entry: any) => String(entry.resolvedPath ?? entry.path));
	if (!paths.some((path: string) => path.includes("pi-web-access"))) {
		throw new Error(`pi-web-access did not load: ${JSON.stringify({ paths, errors: loaded.errors ?? [] })}`);
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
	const pairs = [
		["web_search", "brave_search"],
		["fetch_content", "brave_fetch"],
		["source_check", "brave_source_check"],
		["get_search_content", "brave_get_content"],
	] as const;
	for (const names of pairs) {
		if (!names.some((name) => registered.has(name))) {
			throw new Error(`missing web tool: ${names.join(" or ")}`);
		}
	}

	console.log("Bundled pi-web-access loaded and registered all four web capabilities.");
} finally {
	session?.dispose?.();
	rmSync(sessionDir, { recursive: true, force: true });
}
