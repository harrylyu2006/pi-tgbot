import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit.ts";
import { loadConfig } from "../src/config.ts";
import { Files } from "../src/telegram/files.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}
function logger(): any {
	return { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
}

const dir = mkdtempSync(join(tmpdir(), "pi-tg-security-"));
const valid = {
	botToken: `12345678:${"A".repeat(30)}`,
	allowedUserId: 1,
	cwd: dir,
	agentDir: join(dir, "agent"),
	sessionDir: join(dir, "sessions"),
	statePath: join(dir, "state.json"),
	auditPath: join(dir, "audit.jsonl"),
	files: { inboxDir: join(dir, "inbox"), outboxRoots: [join(dir, "outbox")], maxDownloadMb: 1, maxUploadMb: 1, retentionDays: 1 },
};
function accepts(name: string, value: unknown): boolean {
	const path = join(dir, `${name}.json`);
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
	try {
		loadConfig(path);
		return true;
	} catch {
		return false;
	}
}

console.log("配置拒绝危险值：");
ok("合法最小配置通过", accepts("valid", valid));
ok("拒绝负 maxChars", !accepts("negative", { ...valid, render: { maxChars: -1 } }));
ok("拒绝 null 嵌套对象", !accepts("null-render", { ...valid, render: null }));
ok("拒绝空 cwd", !accepts("empty-cwd", { ...valid, cwd: "" }));
ok("拒绝文件系统根作为 outbox", !accepts("root-outbox", { ...valid, files: { ...valid.files, outboxRoots: ["/"] } }));
const loosePath = join(dir, "loose-config.json");
writeFileSync(loosePath, JSON.stringify(valid), { mode: 0o644 });
chmodSync(loosePath, 0o644);
let looseAccepted = true;
try { loadConfig(loosePath); } catch { looseAccepted = false; }
ok("拒绝组或其他用户可读的配置", !looseAccepted);

console.log("出站文件真实路径检查：");
const outbox = join(dir, "outbox");
const outside = join(dir, "outside");
mkdirSync(outbox);
mkdirSync(outside);
const safe = join(outbox, "safe.txt");
const secret = join(outside, "secret.txt");
writeFileSync(safe, "safe");
writeFileSync(secret, "secret");
symlinkSync(secret, join(outbox, "link.txt"));
const files = new Files({} as never, logger(), valid.files);
ok("允许根内普通文件", files.check(safe).ok);
ok("拒绝根内指向外部的符号链接", !files.check(join(outbox, "link.txt")).ok);

console.log("审计日志不保存原始参数：");
const audit = new AuditLog(valid.auditPath, logger());
audit.init();
audit.start({ generation: 1, toolCallId: "call-1", toolName: "bash", args: { command: "echo PRIVATE_AUDIT_MARKER", password: "PRIVATE_PASSWORD_MARKER" } });
const record = readFileSync(valid.auditPath, "utf8");
ok("不保存命令正文", !record.includes("PRIVATE_AUDIT_MARKER"));
ok("不保存密码正文", !record.includes("PRIVATE_PASSWORD_MARKER"));
ok("保留参数摘要哈希", record.includes('"argHash"'));

console.log(failures === 0 ? "\nSECURITY CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
