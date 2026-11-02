/**
 * Pull the KeePass database from Google Drive (through rclone, read-only scope) when the operator unlocks.
 *
 * Not a background job: it runs at `/unlock` time, so the Drive token is used a handful of times a day, a stale or revoked
 * token costs nothing but a warning, and a replacement can never lock the database out from under a running task (it only runs
 * while locked). Every failure leaves the local copy exactly as it was.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { looksLikeKdbx } from "./keepass-core.ts";
import type { Keepass } from "./keepass.ts";
import { REMOTE_RE } from "./remote.ts";

export { REMOTE_RE };

export interface SyncConfig {
	/** An rclone remote path to the single .kdbx file, e.g. `gdrive-ro:Folder/passwords.kdbx`. */
	remote: string;
	timeoutSeconds: number;
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Exec = (args: string[], timeoutMs: number) => Promise<ExecResult>;

export type SyncStatus = "updated" | "unchanged" | "kept-local" | "skipped" | "failed";
export interface SyncResult {
	status: SyncStatus;
	/** One short line for the operator. Never contains file contents, tokens or rclone's raw output. */
	message: string;
	driveModTime?: string;
}

const OUTPUT_CAP = 1024 * 1024;

export const rcloneExec: Exec = (args, timeoutMs) => new Promise((resolve) => {
	// No shell: the remote is passed as a single argv element.
	const child = spawn("rclone", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true });
	let stdout = "", stderr = "", timedOut = false, done = false;
	child.stdout.on("data", (d: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8"); });
	child.stderr.on("data", (d: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8"); });
	const kill = (): void => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
	const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
	const finish = (code: number | null): void => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); };
	child.on("error", (err) => { stderr += String(err.message); finish(null); });
	child.on("close", (code) => finish(code));
});

/** Turn rclone's stderr into something the operator can act on, without echoing it. */
export function classify(r: ExecResult): string {
	if (r.timedOut) return "连接 Drive 超时";
	const e = r.stderr;
	if (/invalid_grant|couldn't fetch token|Token has been expired or revoked|invalid_client|unauthorized_client/i.test(e)) return "Drive 授权已失效（令牌被撤销或过期），需要重新授权";
	if (/insufficient authentication scopes|accessNotConfigured|has not been used in project|API has not been enabled/i.test(e)) return "Drive 授权的权限不够或 Drive API 未启用";
	if (/directory not found|object not found|couldn't find file|file not found/i.test(e)) return "在 Drive 上找不到配置的文件（被移动或改名了？）";
	if (/didn't find section in config file/i.test(e)) return "rclone 配置里没有这个远端";
	if (/no such host|dial tcp|connection (?:refused|reset)|i\/o timeout|TLS handshake|network is unreachable|temporary failure in name resolution/i.test(e)) return "连不上 Drive（网络问题）";
	if (/rateLimitExceeded|userRateLimitExceeded|quota/i.test(e)) return "Drive 限流或配额用尽";
	if (r.code === null && /ENOENT/.test(e)) return "服务器上没有安装 rclone";
	return "rclone 返回了错误（详情见服务器日志，已省略原文）";
}

const sha256Of = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const fmtTime = (iso: string): string => iso.slice(0, 16).replace("T", " ") + " UTC";

export async function syncKeepassFromDrive(kp: Keepass, cfg: SyncConfig, opts: { exec?: Exec; maxFileMb?: number } = {}): Promise<SyncResult> {
	const exec = opts.exec ?? rcloneExec;
	const maxBytes = (opts.maxFileMb ?? kp.cfg.maxFileMb) * 1024 * 1024;
	const timeoutMs = cfg.timeoutSeconds * 1000;
	if (kp.unlocked) return { status: "skipped", message: "KeePass 已解锁，未同步" };
	const failed = (message: string): SyncResult => ({ status: "failed", message });

	const ls = await exec(["lsjson", "--hash", "--no-mimetype", "--retries", "1", "--low-level-retries", "2", cfg.remote], timeoutMs);
	if (ls.code !== 0) return failed(classify(ls));
	let item: { Name?: string; Size?: number; ModTime?: string; IsDir?: boolean; Hashes?: Record<string, string> };
	try {
		const list = JSON.parse(ls.stdout) as unknown[];
		if (!Array.isArray(list) || list.length !== 1) return failed(list.length === 0 ? "在 Drive 上找不到配置的文件（被移动或改名了？）" : "配置的 Drive 路径匹配了多个项目，应当指向单个 .kdbx 文件");
		item = list[0] as typeof item;
	} catch { return failed("无法解析 Drive 返回的文件信息"); }
	if (item.IsDir) return failed("配置的 Drive 路径是文件夹，应当指向 .kdbx 文件");
	if (typeof item.Size !== "number" || item.Size <= 0) return failed("Drive 上的文件是空的");
	if (item.Size > maxBytes) return failed(`Drive 上的文件超过 ${kp.cfg.maxFileMb} MB 上限`);
	const driveModTime = typeof item.ModTime === "string" ? item.ModTime : undefined;
	const driveSha = item.Hashes?.sha256?.toLowerCase();

	// Decide whether the Drive copy should replace the local one.
	const local = existsSync(kp.cfg.path) ? kp.meta() : null;
	if (local && driveSha && local.sha256 === driveSha) return { status: "unchanged", message: `本机副本与 Drive 一致（Drive 版本修改于 ${driveModTime ? fmtTime(driveModTime) : "未知"}）`, driveModTime };
	if (local && local.source === "upload") {
		// The operator sent this file by hand. Only a Drive version that is newer than that moment may replace it.
		const drive = driveModTime ? Date.parse(driveModTime) : NaN;
		if (!(drive > Date.parse(local.installedAt))) return { status: "kept-local", message: `本机副本是你手动发来的（${fmtTime(local.installedAt)}），比 Drive 上的版本新，保留未替换`, driveModTime };
	}

	const tmp = `${kp.cfg.path}.sync.tmp`;
	try {
		mkdirSync(dirname(tmp), { recursive: true, mode: 0o700 });
		rmSync(tmp, { force: true });
		const dl = await exec(["copyto", "--retries", "1", "--low-level-retries", "2", cfg.remote, tmp], timeoutMs);
		if (dl.code !== 0) return failed(classify(dl));
		let buf: Buffer;
		try { buf = readFileSync(tmp); } catch { return failed("下载没有产生文件"); }
		if (buf.length !== item.Size) return failed("下载的文件大小与 Drive 不一致，已放弃");
		if (!looksLikeKdbx(buf)) return failed("Drive 上的文件不是 KeePass 数据库（KDBX 3/4），已放弃");
		if (driveSha && sha256Of(buf) !== driveSha) return failed("下载内容的校验和与 Drive 不一致，已放弃");
		if (kp.unlocked) return { status: "skipped", message: "同步期间 KeePass 被解锁了，未替换" };
		kp.installFile(tmp, { source: "drive", ...(driveModTime ? { driveModTime } : {}) });
		return { status: "updated", message: `已从 Drive 同步最新数据库（Drive 版本修改于 ${driveModTime ? fmtTime(driveModTime) : "未知"}，${(buf.length / 1024).toFixed(1)} KB，校验和一致）`, driveModTime };
	} catch (err) {
		return failed(`同步时出错：${err instanceof Error ? err.message.slice(0, 80) : "未知错误"}`);
	} finally {
		rmSync(tmp, { force: true });
	}
}
