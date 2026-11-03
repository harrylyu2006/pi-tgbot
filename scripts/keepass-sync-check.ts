/**
 * Drive sync for KeePass: decision rules (never replace newer with older, never touch the local copy on any failure),
 * integrity checks, failure classification, and the unlock flow around it — with a fake rclone.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/log.ts";
import { Keepass, type KeepassConfig } from "../src/secrets/keepass.ts";
import { REMOTE_RE, classify, syncKeepassFromDrive, type Exec, type ExecResult } from "../src/secrets/drive-sync.ts";
import { SecretsService } from "../src/secrets/service.ts";

let fail = 0;
const ok = (name: string, cond: unknown, extra = ""): void => { if (!cond) fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` ${extra}`}`); };
const section = (s: string): void => console.log(`\n${s}`);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const root = mkdtempSync(join(tmpdir(), "kp-sync-"));
const A = readFileSync(fileURLToPath(new URL("./fixtures/pykeepass-real.kdbx", import.meta.url)));
const B = readFileSync(fileURLToPath(new URL("./fixtures/keepassxc-real.kdbx", import.meta.url)));
const REMOTE = "gdrive-ro:Passwords/passwords.kdbx";
const cfgFor = (dir: string): KeepassConfig => ({ path: join(dir, "main.kdbx"), mode: "session", storedSecret: "keepass-master", idleMinutes: 30, maxHours: 8, hiddenTag: "pitg-hidden", confirmTag: "pitg-confirm", hiddenGroups: [], confirmGroups: [], maxFileMb: 1, maxArgonMiB: 256, maxEntriesPerSession: 8, sync: { remote: REMOTE, timeoutSeconds: 30 } });

/** A fake rclone serving one "Drive file". */
function fakeDrive(initial: Buffer, modTime: string): { exec: Exec; calls: string[][]; set(b: Buffer, m?: string): void; fail(r: Partial<ExecResult> | null): void; override(fn: ((args: string[]) => ExecResult | null) | null): void } {
	let content = initial, mod = modTime, failure: Partial<ExecResult> | null = null, hook: ((args: string[]) => ExecResult | null) | null = null;
	const calls: string[][] = [];
	const exec: Exec = async (args) => {
		calls.push(args);
		if (failure) return { code: 1, stdout: "", stderr: "", timedOut: false, ...failure };
		const h = hook?.(args); if (h) return h;
		if (args[0] === "lsjson") return { code: 0, timedOut: false, stderr: "", stdout: JSON.stringify([{ Name: "passwords.kdbx", Size: content.length, ModTime: mod, IsDir: false, Hashes: { sha256: sha(content), md5: "x" } }]) };
		if (args[0] === "copyto") { writeFileSync(args[args.length - 1]!, content); return { code: 0, stdout: "", stderr: "", timedOut: false }; }
		return { code: 2, stdout: "", stderr: "unexpected", timedOut: false };
	};
	return { exec, calls, set: (b, m) => { content = b; if (m) mod = m; }, fail: (r) => { failure = r; }, override: (fn) => { hook = fn; } };
}
const downloads = (d: { calls: string[][] }): number => d.calls.filter((c) => c[0] === "copyto").length;
const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

section("同步决定规则");
{
	const dir = join(root, "a"); mkdirSync(dir, { recursive: true });
	const kp = new Keepass(cfgFor(dir), { now: () => Date.parse("2026-11-02T00:00:00Z") });
	const drive = fakeDrive(A, "2026-10-31T22:47:55.567Z");
	const r1 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("本机没有文件 → 下载并安装", r1.status === "updated" && readFileSync(kp.cfg.path).equals(A) && downloads(drive) === 1, JSON.stringify(r1));
	ok("记录来源为 drive、保存了 Drive 修改时间、权限 600、无临时文件残留", kp.meta()?.source === "drive" && kp.meta()?.driveModTime === "2026-10-31T22:47:55.567Z" && (statSync(kp.cfg.path).mode & 0o777) === 0o600 && leftovers(dir).length === 0);
	ok("lsjson 带 --hash，远端作为单个 argv 元素原样传入（不经 shell）", drive.calls[0]!.includes("--hash") && drive.calls[0]!.at(-1) === REMOTE && drive.calls[1]!.at(-2) === REMOTE);
	const r2 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("再次同步，内容一致 → unchanged，不下载", r2.status === "unchanged" && downloads(drive) === 1);
	drive.set(B, "2026-11-01T10:00:00.000Z");
	const r3 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("Drive 上变了 → 替换，旧版本保留为 .prev", r3.status === "updated" && readFileSync(kp.cfg.path).equals(B) && readFileSync(`${kp.cfg.path}.prev`).equals(A));
	ok("消息里有 Drive 版本时间与大小，不含文件内容", /2026-11-01 10:00 UTC/.test(r3.message) && /校验和一致/.test(r3.message));
}
{
	const dir = join(root, "b"); mkdirSync(dir, { recursive: true });
	let now = Date.parse("2026-11-01T12:00:00Z");
	const kp = new Keepass(cfgFor(dir), { now: () => now });
	const manual = join(root, "manual.kdbx"); writeFileSync(manual, A);
	kp.installFile(manual); // operator sent it by hand at 12:00
	const drive = fakeDrive(B, "2026-11-01T09:00:00.000Z");
	const r1 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("手动发送的比 Drive 新 → 保留本机，不下载（不会用旧版本悄悄覆盖）", r1.status === "kept-local" && readFileSync(kp.cfg.path).equals(A) && downloads(drive) === 0 && /比 Drive 上的版本新/.test(r1.message), JSON.stringify(r1));
	drive.set(B, "2026-11-01T13:30:00.000Z");
	const r2 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("Drive 在那之后又改过 → 才替换", r2.status === "updated" && readFileSync(kp.cfg.path).equals(B));
	// 没有 sidecar（旧安装）：按文件 mtime 当作手动发送时间
	rmSync(`${kp.cfg.path}.meta.json`);
	utimesSync(kp.cfg.path, new Date("2026-11-02T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
	drive.set(A, "2026-11-01T20:00:00.000Z");
	const r3 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("没有来源记录的旧文件：按文件时间视为手动发送，Drive 更旧则保留", r3.status === "kept-local" && readFileSync(kp.cfg.path).equals(B));
	// sidecar 被篡改/过期（哈希对不上）会被忽略
	kp.installFile(manual, { source: "drive", driveModTime: "2020-01-01T00:00:00Z" });
	writeFileSync(`${kp.cfg.path}.meta.json`, JSON.stringify({ source: "drive", sha256: "0".repeat(64), installedAt: "2000-01-01T00:00:00Z" }));
	drive.set(B, "2026-11-01T01:00:00.000Z");
	utimesSync(kp.cfg.path, new Date("2026-11-02T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
	const r4 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("来源记录与文件哈希不符 → 忽略记录，按保守规则处理", r4.status === "kept-local" && kp.meta()?.source === "upload");
}

section("任何失败都不动本机副本");
{
	const dir = join(root, "c"); mkdirSync(dir, { recursive: true });
	const kp = new Keepass(cfgFor(dir));
	const seed = join(root, "seed.kdbx"); writeFileSync(seed, A); kp.installFile(seed, { source: "drive", driveModTime: "2026-10-01T00:00:00Z" });
	const before = readFileSync(kp.cfg.path);
	const drive = fakeDrive(B, "2026-11-01T00:00:00.000Z");
	const cases: Array<[string, Partial<ExecResult>, RegExp]> = [
		["授权失效 invalid_grant", { stderr: 'CRITICAL: Failed to create file system: couldn\'t fetch token: invalid_grant: maybe token expired?' }, /授权已失效/],
		["权限不够 403", { stderr: "403: Request had insufficient authentication scopes." }, /权限不够/],
		["文件被移走", { stderr: "ERROR : error listing: directory not found" }, /找不到配置的文件/],
		["网络不通", { stderr: "dial tcp: lookup www.googleapis.com: no such host" }, /网络问题/],
		["超时", { timedOut: true, code: null }, /超时/],
		["限流", { stderr: "googleapi: Error 403: User rate limit exceeded, userRateLimitExceeded" }, /限流/],
		["没装 rclone", { code: null, stderr: "spawn rclone ENOENT" }, /没有安装 rclone/],
		["远端不存在", { stderr: 'didn\'t find section in config file ("gdrive-ro")' }, /没有这个远端/],
		["未知错误：不回显原文", { stderr: "something weird with secret-token-abc123" }, /已省略原文/],
	];
	for (const [name, f, re] of cases) {
		drive.fail(f);
		const r = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
		ok(`${name} → failed，提示可操作，本机副本不变`, r.status === "failed" && re.test(r.message) && readFileSync(kp.cfg.path).equals(before) && !r.message.includes("abc123"), r.message);
	}
	drive.fail(null);
	for (const [name, mutate, re] of [
		["Drive 上是目录", () => drive.override(() => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify([{ Name: "x", Size: 0, IsDir: true, ModTime: "2026-11-01T00:00:00Z" }]) })), /文件夹/],
		["路径匹配多个项目", () => drive.override(() => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify([{ Name: "a", Size: 5 }, { Name: "b", Size: 5 }]) })), /多个项目/],
		["lsjson 返回的不是 JSON", () => drive.override(() => ({ code: 0, stderr: "", timedOut: false, stdout: "<html>" })), /无法解析/],
		["Drive 上文件为空", () => drive.override(() => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify([{ Name: "a", Size: 0, ModTime: "2026-11-01T00:00:00Z", IsDir: false }]) })), /是空的/],
		["超过大小上限（1 MB）", () => drive.override(() => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify([{ Name: "a", Size: 5 * 1024 * 1024, ModTime: "2026-11-01T00:00:00Z", IsDir: false, Hashes: { sha256: "ab" } }]) })), /超过 1 MB/],
	] as const) {
		mutate();
		const before = drive.calls.length;
		const r = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
		ok(`${name} → failed，且不会去下载`, r.status === "failed" && re.test(r.message) && !drive.calls.slice(before).some((c) => c[0] === "copyto") && readFileSync(kp.cfg.path).equals(before_(before)), r.message);
	}
	function before_(_: number): Buffer { return A; }
	drive.override(null);

	// 下载内容有问题
	const lsFor = (content: Buffer, size = content.length, hash = sha(content)): ExecResult => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify([{ Name: "a", Size: size, ModTime: "2026-11-02T00:00:00Z", IsDir: false, Hashes: { sha256: hash } }]) });
	const junk = Buffer.from("this is not a keepass database but is the right size!");
	drive.override((args) => args[0] === "lsjson" ? lsFor(junk) : args[0] === "copyto" ? (writeFileSync(args.at(-1)!, junk), { code: 0, stdout: "", stderr: "", timedOut: false }) : null);
	const r1 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("下载内容不是 KDBX → failed，本机不变，临时文件已清理", r1.status === "failed" && /不是 KeePass 数据库/.test(r1.message) && readFileSync(kp.cfg.path).equals(A) && leftovers(dir).length === 0, r1.message);
	drive.override((args) => args[0] === "lsjson" ? lsFor(B, B.length, "f".repeat(64)) : args[0] === "copyto" ? (writeFileSync(args.at(-1)!, B), { code: 0, stdout: "", stderr: "", timedOut: false }) : null);
	const r2 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("校验和与 Drive 报告的不一致 → failed，本机不变", r2.status === "failed" && /校验和/.test(r2.message) && readFileSync(kp.cfg.path).equals(A) && leftovers(dir).length === 0, r2.message);
	drive.override((args) => args[0] === "lsjson" ? lsFor(B, B.length + 10) : args[0] === "copyto" ? (writeFileSync(args.at(-1)!, B), { code: 0, stdout: "", stderr: "", timedOut: false }) : null);
	const r3 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("下载大小与 Drive 报告的不一致 → failed", r3.status === "failed" && /大小/.test(r3.message) && readFileSync(kp.cfg.path).equals(A));
	drive.override((args) => args[0] === "lsjson" ? lsFor(B) : args[0] === "copyto" ? { code: 0, stdout: "", stderr: "", timedOut: false } : null);
	const r4 = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("rclone 说成功但没产生文件 → failed", r4.status === "failed" && /没有产生文件/.test(r4.message) && readFileSync(kp.cfg.path).equals(A));
	drive.override(null);
}

section("已解锁时不同步");
{
	const dir = join(root, "d"); mkdirSync(dir, { recursive: true });
	const kp = new Keepass(cfgFor(dir));
	const f = join(root, "pyk.kdbx"); copyFileSync(fileURLToPath(new URL("./fixtures/pykeepass-real.kdbx", import.meta.url)), f);
	kp.installFile(f); await kp.unlock("Master-pw ünï 123!");
	const drive = fakeDrive(B, "2030-01-01T00:00:00.000Z");
	const r = await syncKeepassFromDrive(kp, kp.cfg.sync!, { exec: drive.exec });
	ok("已解锁 → skipped，完全不访问 Drive，使用中的库不会被锁掉", r.status === "skipped" && drive.calls.length === 0 && kp.unlocked);
	kp.lock();
}

section("配置校验与分类");
{
	ok("合法远端", REMOTE_RE.test("gdrive-ro:Passwords/passwords.kdbx") && REMOTE_RE.test("my.remote_1:a b/c.kdbx"));
	ok("拒绝：以 - 开头（参数注入）、无冒号、含换行/NUL、空路径", !REMOTE_RE.test("--config=/etc/passwd:x") && !REMOTE_RE.test("-v:x") && !REMOTE_RE.test("noColon") && !REMOTE_RE.test("a:b\nc") && !REMOTE_RE.test("a:b\0c") && !REMOTE_RE.test("a:"));
	ok("classify 对空输出给出兜底而不是空串", classify({ code: 1, stdout: "", stderr: "", timedOut: false }).length > 0);
}

section("/unlock 流程里的同步");
{
	const sent: any[] = [];
	const mk = async (name: string, drive: ReturnType<typeof fakeDrive>): Promise<SecretsService> => {
		const svc = await SecretsService.create({
			config: { baseUrl: "https://vault.test", host: "127.0.0.1", port: 0, dir: join(root, `${name}-v`), keyPath: join(root, `${name}-k`, "vault.key"), linkTtlSeconds: 120, auditPath: join(root, `${name}-audit.jsonl`), denyPlaceholderTools: [],
				keepass: { ...cfgFor(join(root, `${name}-kp`)) } },
			api: { sendMessage: async (p: any) => { sent.push(p); return { message_id: sent.length }; }, editMessageText: async () => true, call: async () => true } as any,
			ui: { confirm: async () => true } as any, log: createLogger("t"), operatorChatId: 1, currentChatId: () => 1, exec: drive.exec,
		});
		await svc.start();
		return svc;
	};
	const drive = fakeDrive(A, "2026-10-31T22:47:55.567Z");
	const svc = await mk("e", drive);
	ok("起初没有任何本机文件", !svc.keepass!.fileInfo().exists);
	const res = await svc.requestUnlock({ chatId: 1, wait: false, origin: "t" });
	ok("/unlock：先从 Drive 拉取，再发按钮——用户不必手动发文件", res.kind === "pending" && svc.keepass!.fileInfo().exists && readFileSync(svc.keepass!.cfg.path).equals(A));
	ok("按钮消息里说明已同步及 Drive 版本时间", /已从 Drive 同步最新数据库/.test(sent.at(-1).text) && /2026-10-31 22:47 UTC/.test(sent.at(-1).text) && sent.at(-1).reply_markup.inline_keyboard[0][0].url.includes("/s/"));
	ok("链接不在消息文字里", !sent.at(-1).text.includes("/s/"));
	drive.fail({ stderr: "invalid_grant" });
	await svc.requestUnlock({ chatId: 1, wait: false, origin: "t" });
	ok("Drive 授权失效：仍发解锁按钮，并明确告警 + 说明用的是本机副本", /没能从 Drive 同步：Drive 授权已失效/.test(sent.at(-1).text) && /这次使用本机已有的副本（本机副本来自 Drive/.test(sent.at(-1).text) && sent.at(-1).reply_markup);
	ok("同步失败会记入 /secrets 状态行", (await svc.handleCommand("/secrets", 1, 1)) && /Drive 同步：⚠️失败/.test(sent.at(-1).text));
	const audit = readFileSync(join(root, "e-audit.jsonl"), "utf8");
	ok("审计里有 keepass-sync 记录（状态，无文件内容）", /"event":"keepass-sync","status":"updated"/.test(audit) && /"status":"failed"/.test(audit));
	await svc.stop();

	// Legacy restart markers must no longer prompt or sync: unlock is on demand only.
	const flag = join(root, "unlock-on-start");
	const sd = fakeDrive(A, "2026-10-31T22:47:55.567Z");
	const ss = await mk("s", sd);
	const before = sent.length;
	ok("没有标记 → 什么都不做", (await ss.startupUnlock(flag)) === null && sent.length === before && sd.calls.length === 0);
	writeFileSync(flag, "");
	const su = await ss.startupUnlock(flag);
	ok("有旧标记 → 只清理标记，不发送消息、不同步 Drive", su === null && !existsSync(flag) && sent.length === before && sd.calls.length === 0);
	ok("启动不会安装或解锁密码库", !ss.keepass!.fileInfo().exists && !ss.keepass!.unlocked);
	ok("反复启动检查也不会提示", (await ss.startupUnlock(flag)) === null && sent.length === before && sd.calls.length === 0);
	const demand = await ss.requestUnlock({ chatId: 1, wait: false, origin: "agent:test", description: "当前任务需要登录服务器" });
	ok("实际任务按需请求仍同步并发送解锁按钮", demand.kind === "pending" && sent.length === before + 1 && sd.calls.length > 0 && !!sent.at(-1).reply_markup.inline_keyboard[0][0].url);
	const afterDemand = sent.length, syncCalls = sd.calls.length;
	await ss.stop();
	writeFileSync(flag, "");
	const down = await ss.startupUnlock(flag);
	ok("服务未启动时也只清理旧标记，不额外报错打扰", down === null && !existsSync(flag) && sent.length === afterDemand && sd.calls.length === syncCalls);
	await svc.stop();

	// 没有本机文件且同步失败 → 明确报错
	const bad = fakeDrive(A, "2026-10-31T22:47:55.567Z"); bad.fail({ stderr: "directory not found" });
	const svc2 = await mk("f", bad);
	const e = await svc2.requestUnlock({ chatId: 1, wait: false, origin: "t" });
	ok("没有本机副本且 Drive 同步失败 → 报错并带上原因，让 AI 转告用户", e.kind === "error" && /Drive sync: 在 Drive 上找不到配置的文件/.test((e as any).message), JSON.stringify(e));
	// 并发调用共用一次同步
	const slow = fakeDrive(A, "2026-10-31T22:47:55.567Z"); let n = 0; slow.override((args) => { if (args[0] === "lsjson") n++; return null; });
	const svc3 = await mk("g", slow);
	await Promise.all([svc3.driveSync(), svc3.driveSync(), svc3.driveSync()]);
	ok("并发触发只同步一次", n === 1, String(n));
	await svc2.stop(); await svc3.stop();
	// 没配置 sync：行为与之前完全一样
	const none = await SecretsService.create({ config: { baseUrl: "https://vault.test", host: "127.0.0.1", port: 0, dir: join(root, "h-v"), keyPath: join(root, "h-k", "vault.key"), linkTtlSeconds: 120, auditPath: join(root, "h-a.jsonl"), denyPlaceholderTools: [], keepass: { ...cfgFor(join(root, "h-kp")), sync: undefined } },
		api: { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => true, call: async () => true } as any, ui: { confirm: async () => true } as any, log: createLogger("t"), operatorChatId: 1, currentChatId: () => 1, exec: async () => { throw new Error("must not be called"); } });
	ok("未配置 sync：driveSync 返回 null，不调用 rclone", (await none.driveSync()) === null);
}

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nDrive 同步验证通过" : `\n${fail} 处不符`);
process.exit(fail === 0 ? 0 : 1);
