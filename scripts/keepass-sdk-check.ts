/**
 * End-to-end through the real pi SDK with a scripted fake model: a KeePass password, a custom field and a TOTP code are
 * used through secret_run and a placeholder, and none of them may appear in any request sent to the model provider or in
 * the persisted session file.
 */
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHost } from "../src/agent/host.ts";
import { SecretsService } from "../src/secrets/service.ts";
import { createSecretsExtension } from "../src/secrets/extension.ts";
import { parseOtpAuth, totpAt } from "../src/secrets/totp.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/pykeepass-real.kdbx", import.meta.url));
const MASTER = "Master-pw ünï 123!";
const PW = "gh-Passw0rd-xyz", CUSTOM = "custom-secret-9999";
const root = mkdtempSync(join(tmpdir(), "kp-sdk-"));
const agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
mkdirSync(agentDir, { recursive: true });

const requests: string[] = [];
const idFor = (body: string, title: string): string => new RegExp(String.raw`id=([0-9a-f]{12}) \| (?:[^|]*/)?${title}\b`).exec(body)?.[1] ?? "000000000000";
const script: Array<(body: string) => { text?: string; tool?: { name: string; args: unknown } }> = [
	() => ({ tool: { name: "keepass_search", args: { query: "" } } }),
	(b) => ({ tool: { name: "secret_run", args: { command: 'echo "login with $P"; printf "%s" "$P" | base64', env: { P: `kp:${idFor(b, "GitHub")}#password` } } } }),
	(b) => ({ tool: { name: "echo_args", args: { text: `{{secret:kp:${idFor(b, "GitHub")}#password}}` } } }),
	(b) => ({ tool: { name: "secret_run", args: { command: 'echo "code=$T"', env: { T: `kp:${idFor(b, "GitHub")}#totp` } } } }),
	(b) => ({ tool: { name: "echo_args", args: { text: `{{secret:kp:${idFor(b, "Staging root")}#API Key}}` } } }),
	() => ({ tool: { name: "bash", args: { command: "echo {{secret:kp:aaaaaaaaaaaa#password}}" } } }),
	() => ({ text: "all done" }),
];
let turn = 0;
const fake = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		requests.push(raw);
		const step = script[Math.min(turn++, script.length - 1)]!(raw);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
		const base = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "fake" };
		if (step.tool) {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		} else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = (fake.address() as { port: number }).port;
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "unused" } }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
	baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: "unused", api: "openai-completions",
	models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 2048 }],
} } }));

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const api: any = { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => true, call: async () => true };
const confirms: string[] = [];
const ui: any = { confirm: async (t: string) => { confirms.push(t); return true; } };
const svc = await SecretsService.create({
	config: { baseUrl: "https://vault.test", host: "127.0.0.1", port: 0, dir: join(root, "vault"), keyPath: join(root, "vk", "vault.key"),
		linkTtlSeconds: 120, auditPath: join(root, "audit.jsonl"), denyPlaceholderTools: ["write", "edit"],
		keepass: { path: join(root, "kp", "main.kdbx"), mode: "session", storedSecret: "keepass-master", idleMinutes: 30, maxHours: 8, hiddenTag: "pitg-hidden", confirmTag: "pitg-confirm", hiddenGroups: [], confirmGroups: [], maxFileMb: 64, maxArgonMiB: 256, maxEntriesPerSession: 8 } },
	api, ui, log, operatorChatId: 1, currentChatId: () => 1,
});
copyFileSync(FIXTURE, join(root, "fixture.kdbx"));
svc.keepass!.installFile(join(root, "fixture.kdbx"));
await svc.keepass!.unlock(MASTER);

const echoed: string[] = [];
const testExtension = (pi: any): void => {
	pi.registerTool({
		name: "echo_args", label: "Echo", description: "Test tool that echoes its argument back (like a page echoing a typed value)",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		async execute(_id: string, p: { text: string }) { echoed.push(p.text); return { content: [{ type: "text", text: `page shows: ${p.text}` }], details: { seen: p.text } }; },
	});
};
let settled!: () => void;
const done = new Promise<void>((r) => { settled = r; });
const host = new AgentHost({
	config: { botToken: "unused", allowedUserId: 1, cwd: root, agentDir, sessionDir, logLevel: "error",
		render: { editThrottleMs: 1000, maxChars: 3800, maxEditsPerTurn: 10, notifyAfterMs: 30000 },
		tools: { deny: [], extraActive: [] }, turn: { idleTimeoutMs: 1200000 }, model: "test/fake", extensions: [] } as any,
	log, onEvent(_g, e) { if (e.type === "agent_settled") settled(); }, onAbortRequested() {}, onShutdownRequested() {},
	extensionFactories: [{ name: "secrets", factory: createSecretsExtension(svc) }, { name: "echo", factory: testExtension }],
});

let failures = 0;
const ok = (name: string, c: unknown, extra = ""): void => { if (!c) failures++; console.log(`  ${c ? "✓" : "✗"} ${name}${c ? "" : ` ${extra}`}`); };
try {
	await host.start();
	const session = host.session as any;
	const active = session.getActiveToolNames();
	ok("真实 SDK 里 KeePass 工具已激活", ["keepass_status", "keepass_unlock", "keepass_lock", "keepass_search"].every((n) => active.includes(n)), active.join(","));
	const t0 = Date.now();
	await session.prompt("登录 GitHub");
	await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for agent_settled")), 60000))]);

	ok("模型被调用了 7 轮", requests.length === 7, String(requests.length));
	const p = parseOtpAuth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP");
	const codes = [-30_000, 0, 30_000].map((d) => totpAt(p, t0 + d)).concat([totpAt(p, Date.now())]);
	const everything = requests.join("\n");
	ok("【核心】发给模型的所有请求里都没有 KeePass 密码", !everything.includes(PW));
	ok("【核心】也没有它的 base64 形式", !everything.includes(Buffer.from(PW).toString("base64")));
	ok("【核心】也没有自定义字段的值", !everything.includes(CUSTOM));
	ok("【核心】也没有当时有效的 TOTP 码", codes.every((c) => !new RegExp(`(?<!\\d)${c}(?!\\d)`).test(everything)), codes.join(","));
	ok("模型看到 search 的元数据：标题/用户/网址", /GitHub/.test(requests[1]!) && /alice/.test(requests[1]!) && /github\.com/.test(requests[1]!));
	ok("search 结果里没有隐藏条目", !/Bank/.test(everything));
	ok("模型看到的是 [SECRET:kp:…] 标记", /\[SECRET:kp:[0-9a-f]{12}#password\]/.test(requests[2]!));
	ok("占位符工具真的收到了明文密码（执行侧）", echoed[0] === PW);
	ok("echo_args 回显的明文被擦掉后才给模型", /page shows: \[SECRET:kp:/.test(requests[3]!));
	ok("TOTP 子进程输出被擦", /code=\[SECRET:kp:[0-9a-f]{12}#totp\]/.test(requests[4]!), requests[4]!.slice(-300));
	ok("带空格字段名的占位符执行侧拿到了值", echoed[1] === CUSTOM);
	ok("模型请求里保留的是占位符，不是明文", /\{\{secret:kp:[0-9a-f]{12}#password\}\}/.test(requests[3]!));
	ok("bash 里的占位符被拦并给了指引", /refused in bash/.test(requests[6]!) && /secret_run/.test(requests[6]!));
	const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
	const sessionText = files.map((f) => readFileSync(join(sessionDir, f), "utf8")).join("\n");
	ok("【核心】持久化的会话文件里没有密码/自定义字段值/其 base64", files.length > 0 && !sessionText.includes(PW) && !sessionText.includes(CUSTOM) && !sessionText.includes(Buffer.from(PW).toString("base64")));
	ok("【核心】会话文件里也没有 TOTP 码", codes.every((c) => !new RegExp(`(?<!\\d)${c}(?!\\d)`).test(sessionText)));
	ok("会话文件里调用参数保留占位符", /\{\{secret:kp:[0-9a-f]{12}#password\}\}/.test(sessionText));
	ok("【核心】主密码从未出现在请求/会话/审计里", ![everything, sessionText, readFileSync(join(root, "audit.jsonl"), "utf8")].some((t) => t.includes("Master-pw")));
	ok("Staging root 是 confirm 条目：取它的字段时触发了 TG 确认", confirms.some((t) => /Staging root/.test(t)), confirms.join("|"));
	const audit = readFileSync(join(root, "audit.jsonl"), "utf8");
	ok("审计里有 search 与 use，无明文", /keepass-search/.test(audit) && /"tool":"secret_run"/.test(audit) && !audit.includes(PW) && !audit.includes(CUSTOM));
} finally {
	await host.stop().catch(() => undefined);
	await svc.stop();
	fake.close();
	rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nKEEPASS SDK END-TO-END PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
