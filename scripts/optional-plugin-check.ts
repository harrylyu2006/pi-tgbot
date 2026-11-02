/**
 * The secrets plugin and its KeePass part are optional: without configuration none of their code is loaded, and without the
 * optional `kdbxweb` dependency the vault still works while KeePass switches itself off.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";

let fail = 0;
const ok = (name: string, cond: unknown, extra = ""): void => { if (!cond) fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` ${extra}`}`); };
const section = (s: string): void => console.log(`\n${s}`);
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const root = mkdtempSync(join(tmpdir(), "optional-plugin-"));

function child(mode: string, opts: { blockKdbxweb?: boolean } = {}): { result: any; loaded: string[]; stderr: string } {
	const trace = join(root, `trace-${mode}-${opts.blockKdbxweb ? "b" : "a"}.txt`);
	writeFileSync(trace, "");
	const r = spawnSync(process.execPath, ["--import", here("./fixtures/trace-resolve.mjs"), here("./fixtures/optional-child.ts"), mode], {
		encoding: "utf8", timeout: 60_000, env: { ...process.env, TRACE_RESOLVE_FILE: trace, ...(opts.blockKdbxweb ? { BLOCK_KDBXWEB: "1" } : {}) },
	});
	const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
	return { result: line ? JSON.parse(line.slice(7)) : null, loaded: [...new Set(readFileSync(trace, "utf8").split("\n").filter(Boolean))], stderr: r.stderr };
}

section("没有配置 secrets：启动路径不加载任何插件代码");
{
	const c = child("core", { blockKdbxweb: true });
	ok("核心启动路径（config/commands/redact/ui）可以加载，即使 kdbxweb 不可用", c.result?.loaded === true, c.stderr.slice(0, 300));
	ok("没有加载 kdbxweb", !c.loaded.some((x) => x.startsWith("kdbxweb")), c.loaded.join());
	ok("没有加载 service / keepass / drive-sync / extension / plugin（config 只用到 remote.ts 这个无依赖小文件）", !c.loaded.some((x) => /secrets\/(service|keepass|keepass-core|drive-sync|extension|plugin|vault|server)\.ts/.test(x)), c.loaded.join());
}

section("启用 secrets、不配置 keepass：不需要 kdbxweb");
{
	const c = child("plugin-only", { blockKdbxweb: true });
	ok("kdbxweb 不可用时插件照常加载，保险库可用", c.result?.vaultWorks === true && c.result.hasKeepass === false && c.result.keepassObject === false, c.stderr.slice(0, 400));
	ok("没有尝试解析 kdbxweb，也没有加载 keepass.ts", !c.loaded.some((x) => x.startsWith("kdbxweb") || x === "secrets/keepass.ts"), c.loaded.join());
	ok("没有记录任何错误", (c.result?.logs ?? []).length === 0);
}

section("配置了 keepass 但缺少可选依赖：KeePass 自己关掉，保险库不受影响");
{
	const c = child("plugin-keepass-blocked", { blockKdbxweb: true });
	ok("插件仍然加载成功、保险库可用", c.result?.vaultWorks === true, c.stderr.slice(0, 400));
	ok("KeePass 被关闭（hasKeepass=false，没有 Keepass 对象）", c.result?.hasKeepass === false && c.result?.keepassObject === false);
	ok("日志里有一条明确的原因，指向 kdbxweb 与 npm install", (c.result?.logs ?? []).some((l: string) => /KeePass support disabled/.test(l) && /kdbxweb/.test(l) && /npm install/.test(l)), JSON.stringify(c.result?.logs));
}

section("配置了 keepass 且依赖存在");
{
	const c = child("plugin-keepass");
	ok("KeePass 启用", c.result?.hasKeepass === true && c.result?.keepassObject === true && c.result?.vaultWorks === true, c.stderr.slice(0, 400));
	ok("此时才加载 kdbxweb 与 keepass.ts", c.loaded.some((x) => x.startsWith("kdbxweb")) && c.loaded.includes("secrets/keepass.ts"), c.loaded.join());
}

section("配置文件层面");
{
	// The token is assembled so the publication scanner does not mistake a fixture for a real one.
	const base = { botToken: ["123456789", "AAFAKEfaketokenfortestingonly1234567"].join(":"), allowedUserId: 1, statePath: join(root, "s.json"), auditPath: join(root, "a.jsonl") };
	const write = (extra: object): string => { const p = join(root, `c-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify({ ...base, ...extra }), { mode: 0o600 }); return p; };
	ok("没有 secrets 段 → config.secrets 为空（功能整体关闭）", loadConfig(write({})).secrets === undefined);
	const onlySecrets = loadConfig(write({ secrets: { baseUrl: "https://vault.example.com" } }));
	ok("只有 secrets 段 → 没有 keepass", onlySecrets.secrets !== undefined && onlySecrets.secrets.keepass === undefined);
	const both = loadConfig(write({ secrets: { baseUrl: "https://vault.example.com", keepass: {} } }));
	ok("secrets.keepass 为空对象 → 启用 KeePass 并使用默认值", both.secrets?.keepass?.idleMinutes === 30 && both.secrets.keepass.sync === undefined);
	ok("默认监听回环地址；非回环地址被拒绝", both.secrets?.host === "127.0.0.1" && (() => { try { loadConfig(write({ secrets: { baseUrl: "https://vault.example.com", listenHost: "0.0.0.0" } })); return false; } catch { return true; } })());
	ok("package.json：kdbxweb 是可选依赖，不在必需依赖里", (() => { const p = JSON.parse(readFileSync(here("../package.json"), "utf8")); return !!p.optionalDependencies?.kdbxweb && !p.dependencies?.kdbxweb; })());
}

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n可选插件验证通过" : `\n${fail} 处不符`);
process.exit(fail === 0 ? 0 : 1);
