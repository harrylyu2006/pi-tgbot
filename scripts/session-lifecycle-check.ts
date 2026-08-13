import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent/host.ts";

const root = mkdtempSync(join(tmpdir(), "pi-tgbot-session-lifecycle-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const extensionPath = join(root, "lifecycle-extension.ts");
const markerPath = join(root, "events.jsonl");
const authPath = join(agentDir, "auth.json");
const modelsPath = join(agentDir, "models.json");

mkdirSync(agentDir, { recursive: true });
writeFileSync(authPath, JSON.stringify({ test: { type: "api_key", key: "unused" } }), "utf8");
writeFileSync(modelsPath, JSON.stringify({
	providers: {
		test: {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "unused",
			api: "openai-completions",
			models: [{
				id: "lifecycle-test",
				name: "Lifecycle Test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			}],
		},
	},
}), "utf8");

writeFileSync(
	extensionPath,
	`import { appendFileSync } from "node:fs";
import { Type } from "typebox";
const marker = ${JSON.stringify(markerPath)};
export default function (pi) {
  pi.on("session_start", (event) => {
    appendFileSync(marker, JSON.stringify({ type: "start", reason: event.reason }) + "\\n");
  });
  pi.on("session_shutdown", (event) => {
    appendFileSync(marker, JSON.stringify({ type: "shutdown", reason: event.reason }) + "\\n");
  });
  pi.registerTool({
    name: "lifecycle_probe",
    label: "Lifecycle Probe",
    description: "Probe replacement-session extension runtime freshness",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
	"utf8",
);

const log = {
	info() {},
	warn() {},
	error() {},
	debug() {},
	child() { return this; },
} as any;

const host = new AgentHost({
	config: {
		botToken: "unused",
		allowedUserId: 1,
		cwd: process.cwd(),
		agentDir,
		sessionDir,
		logLevel: "error",
		render: { editThrottleMs: 1000, maxChars: 3800, maxEditsPerTurn: 10, notifyAfterMs: 30000 },
		tools: { deny: [], extraActive: [] },
		turn: { idleTimeoutMs: 1200000 },
		model: "test/lifecycle-test",
		extensions: [extensionPath],
	} as any,
	log,
	onEvent() {},
	onAbortRequested() {},
	onShutdownRequested() {},
});

let failures = 0;
function ok(name: string, condition: boolean): void {
	if (!condition) failures++;
	console.log(`  ${condition ? "✓" : "✗"} ${name}`);
}

try {
	await host.start();
	const firstSession = host.session as any;
	const firstTool = firstSession.getAllTools().find((tool: any) => tool.name === "lifecycle_probe");
	ok("初始会话扩展工具可用", Boolean(firstTool));

	await host.reset();
	const secondSession = host.session as any;
	const secondTool = secondSession.getAllTools().find((tool: any) => tool.name === "lifecycle_probe");
	ok("新会话重新注册扩展工具", Boolean(secondTool));
	const secondDefinition = secondSession.getToolDefinition("lifecycle_probe");
	const result = await secondDefinition.execute("probe", {}, undefined, undefined, secondSession.createReplacedSessionContext());
	const text = result?.content?.map((part: any) => part.text ?? "").join("") ?? "";
	ok("新会话工具未持有 stale ctx", text === "ok");

	const events = (await import("node:fs")).readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
	ok("reset 前发出 session_shutdown(new)", events.some((event: any) => event.type === "shutdown" && event.reason === "new"));
	ok("替换会话再次发出 session_start", events.filter((event: any) => event.type === "start").length === 2);
} finally {
	await host.stop().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSESSION LIFECYCLE CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
