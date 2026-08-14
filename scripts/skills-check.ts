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
const sessionDir = mkdtempSync(join(tmpdir(), "pi-tgbot-skills-"));
const skillsPath = fileURLToPath(new URL("../skills", import.meta.url));

let session: any;
try {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalSkillPaths: [skillsPath],
	});
	await loader.reload();

	const loaded = loader.getSkills();
	const skillNames = (loaded.skills ?? []).map((entry: any) => String(entry.name));
	if (!skillNames.includes("image-describe")) {
		throw new Error(`builtin image-describe skill did not load: ${JSON.stringify({ skillNames, diagnostics: loaded.diagnostics ?? [] })}`);
	}

	const created = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, sessionDir),
		excludeTools: [],
	});
	session = created.session;

	const sessionSkills = (session.resourceLoader?.getSkills?.()?.skills ?? []).map((s: any) => s.name);
	if (!sessionSkills.includes("image-describe")) {
		throw new Error(`session resourceLoader missing image-describe: ${JSON.stringify(sessionSkills)}`);
	}

	console.log("Builtin image-describe skill loaded and verified successfully.");
} finally {
	session?.dispose?.();
	rmSync(sessionDir, { recursive: true, force: true });
}
