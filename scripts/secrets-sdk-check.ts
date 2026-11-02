/**
 * End-to-end through the real pi SDK with a scripted fake model server:
 * the invariant "a stored secret's value never reaches the model provider or the
 * persisted session" is checked on the actual requests and the actual JSONL.
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent/host.ts";
import { SecretsService, savedNotice } from "../src/secrets/service.ts";
import { createSecretsExtension } from "../src/secrets/extension.ts";

const PW = "Zq7!hD3k-end2end Secret";
const root = mkdtempSync(join(tmpdir(), "secrets-sdk-"));
const agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
mkdirSync(agentDir, { recursive: true });

// ---- scripted model ---------------------------------------------------------
const requests: string[] = [];
const script: Array<(body: any) => { text?: string; tool?: { name: string; args: unknown } }> = [
	() => ({ tool: { name: "secret_run", args: { command: 'echo "login with $T"; printf "%s" "$T" | base64', env: { T: "demo" } } } }),
	() => ({ tool: { name: "echo_args", args: { text: "{{secret:demo}}" } } }),
	() => ({ tool: { name: "bash", args: { command: "echo {{secret:demo}}" } } }),
	() => ({ text: "all done" }),
];
let turn = 0;
const fake = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		requests.push(raw);
		const step = script[Math.min(turn++, script.length - 1)]!(JSON.parse(raw));
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
	models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
} } }));

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const sent: any[] = [];
const api: any = { sendMessage: async (p: any) => { sent.push(p); return { message_id: sent.length }; }, editMessageText: async () => true, call: async () => true };
const ui: any = { confirm: async () => true };
const svc = await SecretsService.create({
	config: { baseUrl: "https://vault.test", host: "127.0.0.1", port: 0, dir: join(root, "vault"), keyPath: join(root, "vk", "vault.key"),
		linkTtlSeconds: 120, auditPath: join(root, "audit.jsonl"), denyPlaceholderTools: ["write", "edit"] },
	api, ui, log, operatorChatId: 1, currentChatId: () => 1,
});
svc.vault.set("demo", PW, { description: "e2e" });

const echoed: string[] = [];
const testExtension = (pi: any): void => {
	pi.registerTool({
		name: "echo_args", label: "Echo", description: "Test tool that echoes its argument back (like a page echoing a typed value)",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		async execute(_id: string, p: { text: string }) { echoed.push(p.text); return { content: [{ type: "text", text: `page shows: ${p.text}` }], details: { seen: p.text } }; },
	});
};

let settled!: () => void;
let done = new Promise<void>((r) => { settled = r; });
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
	ok("真实 SDK 里 4 个 secret 工具已激活", ["secret_request", "secret_list", "secret_delete", "secret_run"].every((n) => active.includes(n)), active.join(","));
	await session.prompt("请用保险库里的 demo 登录");
	await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for agent_settled")), 30000))]);

	ok("模型被调用了 4 轮", requests.length === 4, String(requests.length));
	ok("【核心】发给模型的所有请求里都没有明文", requests.every((r) => !r.includes(PW)));
	const b64 = Buffer.from(PW).toString("base64");
	ok("【核心】也没有 base64 形式", requests.every((r) => !r.includes(b64)));
	ok("模型看到的是 [SECRET:demo] 标记", requests[1]!.includes("[SECRET:demo]"), requests[1]!.slice(-600));
	ok("占位符工具真的收到了明文（执行侧）", echoed.length === 1 && echoed[0] === PW);
	ok("模型请求里保留的是占位符，不是明文", requests[2]!.includes("{{secret:demo}}"));
	ok("echo_args 回显的明文被擦掉后才给模型", requests[2]!.includes("page shows: [SECRET:demo]"));
	ok("bash 里的占位符被拦并给了指引", /refused in bash/.test(requests[3]!) && /secret_run/.test(requests[3]!));
	const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
	const sessionText = files.map((f) => readFileSync(join(sessionDir, f), "utf8")).join("\n");
	ok("【核心】持久化的会话文件里没有明文", files.length > 0 && !sessionText.includes(PW) && !sessionText.includes(b64));
	ok("会话文件里调用参数保留占位符", sessionText.includes("{{secret:demo}}"));
	// Saved-notice: delivered to the model as a prompt, value-free, even when the same value is in the vault.
	const before = requests.length;
	done = new Promise<void>((r) => { settled = r; });
	await session.prompt(savedNotice({ name: "demo", description: "e2e", length: PW.length, confirm: false, scrubbable: true, replacing: true, origin: "operator", chatId: 1, messageId: 1 }));
	await Promise.race([done, new Promise((_, rej) => setTimeout(rej, 30000, new Error("timeout waiting for notice turn")))]);
	const noticeReq = requests.slice(before).join("\n");
	ok("通知作为提示到达模型", /系统通知，不是操作员键入/.test(noticeReq) && noticeReq.includes("「demo」"));
	ok("通知轮的请求里仍然没有明文", !noticeReq.includes(PW));
	const audit = readFileSync(join(root, "audit.jsonl"), "utf8");
	ok("审计里记录了使用且无明文", /"tool":"secret_run"/.test(audit) && /"tool":"echo_args"/.test(audit) && !audit.includes(PW));
} finally {
	await host.stop().catch(() => undefined);
	fake.close();
	rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nSECRETS SDK END-TO-END PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
