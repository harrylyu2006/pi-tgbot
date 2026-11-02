/** The optional Drive authorization helper: PKCE/state, every refusal path, exact-scope check, and a careful rclone.conf edit. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthError, REDIRECT, SCOPE, finishAuth, startAuth, withoutSection, type FetchFn } from "./gdrive-oauth.ts";

let fail = 0;
const ok = (name: string, cond: unknown, extra = ""): void => { if (!cond) fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` ${extra}`}`); };
const section = (s: string): void => console.log(`\n${s}`);
const rejects = async (p: Promise<unknown>, re: RegExp): Promise<boolean> => { try { await p; return false; } catch (e) { return e instanceof OAuthError && re.test(e.message); } };

const root = mkdtempSync(join(tmpdir(), "gdrive-oauth-"));
const client = { id: "1234-fake.apps.googleusercontent.com", secret: "GOCSPX-fake-client-secret" };
const T = Date.parse("2026-11-02T00:00:00Z");
const mode = (p: string): number => statSync(p).mode & 0o777;

const fakeFetch = (reply: { ok?: boolean; status?: number; body: any }, seen: { url?: string; body?: URLSearchParams } = {}): FetchFn => async (url, init) => {
	seen.url = url; seen.body = new URLSearchParams(init.body);
	return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.body };
};
const goodToken = { access_token: "ya29.fake-access", refresh_token: "1//fake-refresh", expires_in: 3599, scope: SCOPE, token_type: "Bearer" };

section("start");
{
	const state = join(root, "s1", "pending.json");
	const url = new URL(startAuth(client, state, T));
	const q = url.searchParams;
	const pending = JSON.parse(readFileSync(state, "utf8"));
	ok("授权地址指向 Google，只申请 drive.readonly，请求离线与强制同意", url.origin + url.pathname === "https://accounts.google.com/o/oauth2/v2/auth" && q.get("scope") === SCOPE && q.get("access_type") === "offline" && q.get("prompt") === "consent" && q.get("redirect_uri") === REDIRECT && q.get("response_type") === "code");
	ok("PKCE：challenge = base64url(sha256(verifier))，方法 S256", q.get("code_challenge") === createHash("sha256").update(pending.verifier).digest("base64url") && q.get("code_challenge_method") === "S256");
	ok("state 随机且与记录一致；verifier 足够长", q.get("state") === pending.state && pending.state.length >= 30 && pending.verifier.length >= 64);
	ok("待处理记录权限 600，目录 700", mode(state) === 0o600 && mode(join(root, "s1")) === 0o700);
	ok("每次 start 都是新的 state / verifier", JSON.parse(readFileSync(state, "utf8")).state === pending.state && (startAuth(client, state, T), JSON.parse(readFileSync(state, "utf8")).state !== pending.state));
	ok("授权地址里没有 client_secret", !url.href.includes(client.secret));
}

section("finish：拒绝路径（都不能动 rclone.conf）");
{
	const conf = join(root, "rclone.conf");
	const original = "[other]\ntype = s3\naccess_key_id = KEEP-ME\n";
	writeFileSync(conf, original, { mode: 0o600 });
	const state = join(root, "s2", "pending.json");
	const auth = new URL(startAuth(client, state, T));
	const st = auth.searchParams.get("state")!;
	const base = { client, stateFile: state, confPath: conf, remote: "gdrive-ro", now: T + 60_000 };
	const unchanged = (): boolean => readFileSync(conf, "utf8") === original && readdirSync(root).filter((f) => f.startsWith("rclone.conf.")).length === 0;
	ok("空输入", await rejects(finishAuth({ ...base, redir: "  " }), /empty/) && unchanged());
	ok("不是网址", await rejects(finishAuth({ ...base, redir: "code=abc" }), /not an address/) && unchanged());
	ok("没有待处理的授权", await rejects(finishAuth({ ...base, redir: `${REDIRECT}?state=x&code=y`, stateFile: join(root, "none.json") }), /no pending/) && unchanged());
	ok("超过 30 分钟", await rejects(finishAuth({ ...base, now: T + 31 * 60_000, redir: `${REDIRECT}?state=${st}&code=y` }), /older than 30 minutes/) && unchanged());
	ok("Google 报告 error=access_denied", await rejects(finishAuth({ ...base, redir: `${REDIRECT}?error=access_denied&state=${st}` }), /access_denied/) && unchanged());
	ok("state 不匹配（别人的/旧的链接）", await rejects(finishAuth({ ...base, redir: `${REDIRECT}?state=wrong&code=y` }), /state does not match/) && unchanged());
	ok("没有 code", await rejects(finishAuth({ ...base, redir: `${REDIRECT}?state=${st}` }), /no code/) && unchanged());
	ok("非法远端名", await rejects(finishAuth({ ...base, remote: "bad name]\n[evil", redir: `${REDIRECT}?state=${st}&code=y` }), /invalid remote/) && unchanged());
	const cases: Array<[string, any, RegExp, boolean?]> = [
		["令牌端点报错 invalid_grant", { ok: false, status: 400, body: { error: "invalid_grant" } }, /invalid_grant/],
		["没有 refresh_token", { body: { access_token: "a", scope: SCOPE } }, /no refresh token/],
		["授予了更宽的权限（完整 drive）", { body: { ...goodToken, scope: "https://www.googleapis.com/auth/drive" } }, /not exactly drive.readonly/],
		["多授予了别的权限", { body: { ...goodToken, scope: `${SCOPE} https://www.googleapis.com/auth/gmail.readonly` } }, /not exactly drive.readonly/],
		["没有返回 scope", { body: { ...goodToken, scope: undefined } }, /not exactly drive.readonly/],
		["令牌端点返回非 JSON", { ok: false, status: 502, body: undefined }, /HTTP 502/],
	];
	for (const [name, reply, re] of cases) {
		const r = reply.body === undefined ? { ...reply, body: null } : reply;
		const fetchFn: FetchFn = async () => ({ ok: r.ok ?? true, status: r.status ?? 200, json: async () => { if (r.body === null) throw new Error("not json"); return r.body; } });
		ok(`${name} → 拒绝，rclone.conf 不变`, await rejects(finishAuth({ ...base, redir: `${REDIRECT}?state=${st}&code=y`, fetchFn }), re) && unchanged());
	}
	ok("失败后待处理记录仍在（可以用正确的地址重试）", existsSync(state));
}

section("finish：成功路径与 rclone.conf 的改写");
{
	const conf = join(root, "rc2", "rclone.conf");
	const original = "[a]\ntype = s3\nsecret_access_key = AAA\n\n[gdrive-ro]\ntype = drive\ntoken = OLD-TOKEN\n\n[z]\ntype = sftp\nhost = example.com\n";
	mkdirSync(join(root, "rc2"), { recursive: true }); writeFileSync(conf, original, { mode: 0o644 });
	const state = join(root, "s3", "pending.json");
	const auth = new URL(startAuth(client, state, T));
	const pending = JSON.parse(readFileSync(state, "utf8"));
	const seen: { url?: string; body?: URLSearchParams } = {};
	const code = "4/0AFAKE-authorization-code";
	const msg = await finishAuth({ client, stateFile: state, confPath: conf, remote: "gdrive-ro", now: T + 120_000, redir: `${REDIRECT}?state=${auth.searchParams.get("state")}&code=${encodeURIComponent(code)}&scope=x`, fetchFn: fakeFetch({ body: goodToken }, seen) });
	ok("请求发到 Google 令牌端点，带 code、PKCE verifier、客户端凭据与固定的回环 redirect_uri", seen.url === "https://oauth2.googleapis.com/token" && seen.body?.get("code") === code && seen.body.get("code_verifier") === pending.verifier && seen.body.get("client_id") === client.id && seen.body.get("client_secret") === client.secret && seen.body.get("redirect_uri") === REDIRECT && seen.body.get("grant_type") === "authorization_code");
	const next = readFileSync(conf, "utf8");
	const section = (name: string): string => new RegExp(`\\[${name}\\]\\n(?:(?!\\[).*\\n?)*`).exec(next)?.[0] ?? "";
	ok("旧的 gdrive-ro 被替换且只有一份，其它远端逐字节不变", (next.match(/\[gdrive-ro\]/g) ?? []).length === 1 && !next.includes("OLD-TOKEN") && next.includes("[a]\ntype = s3\nsecret_access_key = AAA\n") && next.includes("[z]\ntype = sftp\nhost = example.com\n"));
	const sec = section("gdrive-ro");
	ok("新远端：type=drive、scope=drive.readonly（不是 drive）、客户端凭据、root_folder_id 空", /type = drive\n/.test(sec) && /scope = drive\.readonly\n/.test(sec) && !/scope = drive\n/.test(sec) && sec.includes(`client_id = ${client.id}`) && /root_folder_id = \n?/.test(sec));
	const tok = JSON.parse(/token = (.*)\n/.exec(sec)![1]!);
	ok("令牌 JSON：access/refresh/Bearer，expiry 为 rclone 能读的 RFC3339 且等于 now+expires_in", tok.access_token === goodToken.access_token && tok.refresh_token === goodToken.refresh_token && tok.token_type === "Bearer" && tok.expiry === "2026-11-02T01:01:59.000000000Z" && Date.parse(tok.expiry) === T + 120_000 + 3599_000, tok.expiry);
	ok("rclone.conf 权限 600；生成了同样 600 的备份，内容是改动前的", mode(conf) === 0o600 && (() => { const b = readdirSync(join(root, "rc2")).filter((f) => f.startsWith("rclone.conf.bak.")); return b.length === 1 && mode(join(root, "rc2", b[0]!)) === 0o600 && readFileSync(join(root, "rc2", b[0]!), "utf8") === original; })());
	ok("没有 .tmp 残留；待处理记录已删除（授权码只能用一次）", !existsSync(`${conf}.tmp`) && !existsSync(state));
	ok("返回信息不含授权码、令牌、客户端密钥", !msg.includes(code) && !msg.includes("ya29") && !msg.includes("1//fake") && !msg.includes(client.secret) && /authorized: remote \[gdrive-ro\]/.test(msg), msg);
	ok("再次使用同一地址会被拒绝（没有待处理记录）", await rejects(finishAuth({ client, stateFile: state, confPath: conf, remote: "gdrive-ro", now: T + 130_000, redir: `${REDIRECT}?state=${auth.searchParams.get("state")}&code=${code}`, fetchFn: fakeFetch({ body: goodToken }) }), /no pending/));
}
{
	// rclone.conf 不存在 / 没有末尾换行 / 同名远端在文件末尾
	const state = join(root, "s4", "pending.json");
	const auth = new URL(startAuth(client, state, T));
	const conf = join(root, "fresh", "rclone.conf");
	await finishAuth({ client, stateFile: state, confPath: conf, remote: "mine", now: T, redir: `${REDIRECT}?state=${auth.searchParams.get("state")}&code=c`, fetchFn: fakeFetch({ body: goodToken }) });
	ok("rclone.conf 不存在时新建（600），内容以 [mine] 开头，没有备份文件", /^\[mine\]\ntype = drive\n/.test(readFileSync(conf, "utf8")) && mode(conf) === 0o600 && readdirSync(join(root, "fresh")).length === 1);
	ok("withoutSection：删除末尾的同名段不丢结尾换行，不影响前面的段；没有同名段时原样；全删则为空", withoutSection("[a]\nx = 1\n[b]\ny = 2", "b") === "[a]\nx = 1\n" && withoutSection("[a]\nx = 1\n", "none") === "[a]\nx = 1\n" && withoutSection("[b]\ny = 2\n", "b") === "");
}

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nDrive 授权助手验证通过" : `\n${fail} 处不符`);
process.exit(fail === 0 ? 0 : 1);
