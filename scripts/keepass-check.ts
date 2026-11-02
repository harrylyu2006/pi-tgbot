/**
 * KeePass module checks: TOTP vectors, a database written by a *different* implementation (pykeepass, KDBX4 +
 * Argon2), databases written by kdbxweb (recycle bin, attachments, KeeOtp fields, KDBX3/AES-KDF), visibility
 * and confirm rules, locking, and file installation.
 */
import * as kdbxweb from "kdbxweb";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keepass, KeepassError, looksLikeKdbx, setMemoryProbe, type KeepassConfig } from "../src/secrets/keepass.ts";
import { base32Decode, parseOtpAuth, timeOtpParams, totpAt, TotpError } from "../src/secrets/totp.ts";
import { Scrubber } from "../src/secrets/scrub.ts";

let fail = 0;
const ok = (name: string, cond: unknown, extra = ""): void => { if (!cond) fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` ${extra}`}`); };
const section = (s: string): void => console.log(`\n${s}`);
const throwsCode = async (fn: () => unknown, code: string): Promise<boolean> => { try { await fn(); return false; } catch (e) { return e instanceof KeepassError && e.code === code; } };

const root = mkdtempSync(join(tmpdir(), "keepass-check-"));
const FIXTURE = fileURLToPath(new URL("./fixtures/pykeepass-real.kdbx", import.meta.url));
const MASTER = "Master-pw ünï 123!";
const cfg = (over: Partial<KeepassConfig> = {}): KeepassConfig => ({
	path: join(root, "db.kdbx"), mode: "session", storedSecret: "keepass-master", idleMinutes: 30, maxHours: 8,
	hiddenTag: "pitg-hidden", confirmTag: "pitg-confirm", hiddenGroups: [], confirmGroups: [], maxFileMb: 64, maxArgonMiB: 256, maxEntriesPerSession: 8, ...over,
});

section("TOTP（RFC 6238 官方测试向量）");
{
	const s1 = Buffer.from("12345678901234567890"), s256 = Buffer.from("12345678901234567890123456789012"), s512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");
	const at = (secret: Buffer, algorithm: "sha1" | "sha256" | "sha512", t: number): string => totpAt({ secret, digits: 8, period: 30, algorithm }, t * 1000);
	ok("SHA1  T=59", at(s1, "sha1", 59) === "94287082");
	ok("SHA1  T=1111111109", at(s1, "sha1", 1111111109) === "07081804");
	ok("SHA1  T=20000000000", at(s1, "sha1", 20000000000) === "65353130");
	ok("SHA256 T=59", at(s256, "sha256", 59) === "46119246");
	ok("SHA512 T=59", at(s512, "sha512", 59) === "90693936");
	ok("base32 解码", base32Decode("GEZDGNBVGY3TQOJQ").toString() === "1234567890");
	const p = parseOtpAuth("otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&period=60&digits=8&algorithm=SHA256");
	ok("otpauth 参数解析", p.period === 60 && p.digits === 8 && p.algorithm === "sha256");
	ok("裸 base32 密钥 → 默认 6 位/30 秒/SHA1", (() => { const q = parseOtpAuth("jbsw y3dp ehpk 3pxp"); return q.digits === 6 && q.period === 30 && q.algorithm === "sha1"; })());
	ok("Steam 被明确拒绝", (() => { try { parseOtpAuth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&encoder=steam"); return false; } catch (e) { return e instanceof TotpError; } })());
	ok("HOTP 类型被拒绝", (() => { try { parseOtpAuth("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1"); return false; } catch (e) { return e instanceof TotpError; } })());
	ok("坏 base32 被拒绝", (() => { try { parseOtpAuth("not base32 !!"); return false; } catch (e) { return e instanceof TotpError; } })());
	const k = parseOtpAuth("key=JBSWY3DPEHPK3PXP&size=8&step=60&otpHashMode=Sha256");
	ok("KeeOtp 旧格式 key=…&size=…&step=…&otpHashMode=…", k.digits === 8 && k.period === 60 && k.algorithm === "sha256");
	ok("KeeOtp 旧格式的 Steam 被拒绝", (() => { try { parseOtpAuth("key=JBSWY3DPEHPK3PXP&type=steam"); return false; } catch (e) { return e instanceof TotpError; } })());
	const kp2 = (f: Record<string, string>) => timeOtpParams((n) => f[n]);
	const vec = (p: ReturnType<typeof parseOtpAuth> | null): string => totpAt({ ...p!, digits: 8 }, 59_000);
	ok("KeePass2 TimeOtp-Secret（UTF-8）按 RFC 向量出码", vec(kp2({ "TimeOtp-Secret": "12345678901234567890" })) === "94287082");
	ok("TimeOtp-Secret-Hex", vec(kp2({ "TimeOtp-Secret-Hex": Buffer.from("12345678901234567890").toString("hex") })) === "94287082");
	ok("TimeOtp-Secret-Base64", vec(kp2({ "TimeOtp-Secret-Base64": Buffer.from("12345678901234567890").toString("base64") })) === "94287082");
	ok("TimeOtp-Secret-Base32", vec(kp2({ "TimeOtp-Secret-Base32": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" })) === "94287082");
	ok("TimeOtp-Algorithm/Length/Period 生效", (() => { const q = kp2({ "TimeOtp-Secret-Base32": "JBSWY3DPEHPK3PXP", "TimeOtp-Algorithm": "HMAC-SHA-512", "TimeOtp-Length": "8", "TimeOtp-Period": "45" })!; return q.algorithm === "sha512" && q.digits === 8 && q.period === 45; })());
	ok("没有 TimeOtp 字段 → null；坏 hex → 报错", kp2({}) === null && (() => { try { kp2({ "TimeOtp-Secret-Hex": "zz" }); return false; } catch (e) { return e instanceof TotpError; } })());
}

section("真实数据库（pykeepass 生成，KDBX4 + Argon2）");
{
	ok("签名识别", looksLikeKdbx(readFileSync(FIXTURE)) && !looksLikeKdbx(Buffer.from("PK\x03\x04 not a database at all")));
	copyFileSync(FIXTURE, join(root, "db.kdbx"));
	let locks: string[] = [];
	let t = Date.parse("2026-11-02T00:00:00Z");
	const kp = new Keepass(cfg(), { onLocked: (r) => locks.push(r), now: () => t });
	ok("没解锁时 search 报 locked", await throwsCode(() => kp.search("x"), "locked"));
	ok("错误主密码 → wrong-password", await throwsCode(() => kp.unlock("not the password"), "wrong-password"));
	ok("错误后仍是锁定", !kp.unlocked);
	const n = await kp.unlock(MASTER);
	ok("正确主密码解锁，隐藏条目不计入（3 条里藏 1 条）", n === 2 && kp.unlocked && kp.entryCount === 2, String(n));
	const all = kp.search("").results;
	ok("search 只返回元数据：标题/用户/网址/标签", all.length === 2 && all.every((e) => !JSON.stringify(e).includes("gh-Passw0rd") && !JSON.stringify(e).includes("custom-secret")));
	const gh = kp.search("github").results[0]!, staging = kp.search("staging root").results[0]!;
	ok("按标题/用户/网址搜索", gh.title === "GitHub" && gh.username === "alice" && gh.url.includes("github.com") && gh.hasTotp && kp.search("alice login").results[0]?.id === gh.id);
	ok("分组路径与标签", staging.group === "Servers" && staging.tags.includes("pitg-confirm") && staging.confirm && !gh.confirm);
	ok("自定义字段名可见（值不可见）", staging.extra.includes("API Key"));
	ok("搜不到被 pitg-hidden 标记的条目", kp.search("bank").results.length === 0 && kp.search("bank-top-secret").total === 0);
	ok("多个词需全部命中", kp.search("github servers").total === 0 && kp.search("servers staging").total === 1);
	ok("group 过滤", kp.search("", { group: "Servers" }).results.length === 1);
	const pw = kp.get(`kp:${staging.id}`);
	ok("密码取值正确（含引号、换行）", pw.value === 'p@ss"w0rd\nwith newline' && pw.secret);
	ok("#password 显式字段、完整 uuid 前缀均可", kp.get(`kp:${staging.id}#password`).value === pw.value && kp.get(`kp:${staging.id.slice(0, 8)}#password`).value === pw.value);
	ok("自定义字段（受保护）", kp.get(`kp:${staging.id}#API Key`).value === "custom-secret-9999" && kp.get(`kp:${staging.id}#api key`).value === "custom-secret-9999");
	ok("用户名/网址字段标记为非秘密", (() => { const u = kp.get(`kp:${staging.id}#username`); return u.value === "root" && !u.secret && !kp.get(`kp:${staging.id}#url`).secret; })());
	const code = kp.get(`kp:${gh.id}#totp`);
	const expected = totpAt(parseOtpAuth("otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=30&digits=6"), t);
	ok("TOTP 来自库内 otp 字段、与独立计算一致", code.value === expected && /^\d{6}$/.test(code.value) && code.validForSec! > 0 && code.validForSec! <= 30, `${code.value} vs ${expected}`);
	ok("Notes/Title 不可取", await throwsCode(() => kp.get(`kp:${gh.id}#notes`), "bad-field") && await throwsCode(() => kp.get(`kp:${gh.id}#title`), "bad-field"));
	ok("没有 TOTP 的条目取 totp → 报错", await throwsCode(() => kp.get(`kp:${staging.id}#totp`), "bad-field"));
	ok("不存在的字段 → 报错并列出可用字段", await (async () => { try { kp.get(`kp:${gh.id}#nope`); return false; } catch (e) { return e instanceof KeepassError && /available: password/.test(e.message); } })());

	// 隐藏条目：用别的方式拿到它的 id，确认 agent 无法解析
	const buf = readFileSync(FIXTURE);
	const raw = await kdbxweb.Kdbx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(MASTER)));
	let bankId = "";
	raw.getDefaultGroup().entries.forEach((e) => { if (String(e.fields.get("Title")) === "Bank") bankId = Buffer.from(e.uuid.id, "base64").toString("hex"); });
	ok("拿到了隐藏条目的真实 id（测试用）", bankId.length === 32);
	let hiddenMsg = "", missingMsg = "";
	try { kp.get(`kp:${bankId}#password`); } catch (e) { hiddenMsg = (e as Error).message; }
	try { kp.get("kp:00000000deadbeef#password"); } catch (e) { missingMsg = (e as Error).message; }
	ok("隐藏条目与不存在的条目报错一模一样（不泄露存在性）", hiddenMsg !== "" && hiddenMsg === missingMsg, `${hiddenMsg} | ${missingMsg}`);
	ok("格式不对的引用被拒", await throwsCode(() => kp.get("kp:xyz#password"), "bad-field") && await throwsCode(() => kp.get("kp:abc#password"), "bad-field"));

	// 超时锁定
	t += 29 * 60_000; kp.tick();
	ok("29 分钟内不锁", kp.unlocked);
	kp.search("github"); // 使用会续期
	t += 29 * 60_000; kp.tick();
	ok("使用会续期（滑动空闲）", kp.unlocked);
	t += 31 * 60_000; kp.tick();
	ok("空闲超过 30 分钟自动锁定并回调", !kp.unlocked && locks.join() === "idle");
	ok("锁定后无法再取值", await throwsCode(() => kp.get(`kp:${gh.id}#password`), "locked") && kp.entryCount === 0);
	await kp.unlock(MASTER); locks = [];
	t += 8 * 3_600_000 + 1000; kp.tick();
	ok("无论是否在用，8 小时硬上限必锁", !kp.unlocked && locks.join() === "max");
	await kp.unlock(MASTER);
	ok("手动 lock", kp.lock("manual") && !kp.unlocked && !kp.lock("manual"));
	const [a, b] = [kp.unlock(MASTER), kp.unlock(MASTER)];
	ok("并发解锁共用同一次 Argon2", a === b && (await a) === 2);
	kp.lock("manual");

	// 按分组配置
	const kg = new Keepass(cfg({ confirmGroups: ["Servers"], hiddenGroups: [] }));
	await kg.unlock(MASTER);
	ok("confirmGroups：该组所有条目需确认", kg.search("staging").results[0]!.confirm && !kg.search("github").results[0]!.confirm);
	kg.lock();
	const kh = new Keepass(cfg({ hiddenGroups: ["servers"] }));
	await kh.unlock(MASTER);
	ok("hiddenGroups（大小写不敏感）：整组不可见", kh.entryCount === 1 && kh.search("staging").total === 0);
	kh.lock();
	const kt = new Keepass(cfg({ hiddenTag: "secret-stuff", confirmTag: "ask-me" }));
	await kt.unlock(MASTER);
	ok("标签名可配置", kt.entryCount === 3 && kt.search("bank").total === 1 && !kt.search("staging").results[0]!.confirm);
	kt.lock();
}

section("kdbxweb 生成的数据库（回收站 / 附件 / KeeOtp / KDBX3）");
{
	const make = async (opts: { v3?: boolean }): Promise<Buffer> => {
		const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("pw-two")), "t");
		if (!opts.v3) { db.setKdf(kdbxweb.Consts.KdfId.Argon2id); db.upgrade(); }
		else { db.header.setVersion(3); }
		const g = db.getDefaultGroup();
		const mk = (title: string, pass: string, grp = g): kdbxweb.KdbxEntry => {
			const e = db.createEntry(grp); e.fields.set("Title", title); e.fields.set("UserName", "u-" + title);
			e.fields.set("Password", kdbxweb.ProtectedValue.fromString(pass)); return e;
		};
		const ssh = mk("ssh box", "ssh-pass-1");
		const key = "-----BEGIN FAKE KEY-----\nabcdef\n-----END FAKE KEY-----\n";
		ssh.binaries.set("id_fake", await db.binaries.add(new TextEncoder().encode(key)));
		const bin = mk("binary", "bin-pass-1");
		bin.binaries.set("blob.bin", await db.binaries.add(new Uint8Array([1, 2, 0, 3])));
		const keeotp = mk("keeotp", "otp-pass-1");
		keeotp.fields.set("TimeOtp-Secret-Base32", kdbxweb.ProtectedValue.fromString("JBSWY3DPEHPK3PXP")); keeotp.fields.set("TimeOtp-Period", "30"); keeotp.fields.set("TimeOtp-Length", "6");
		const trash = mk("trashed", "trashed-pass-1");
		db.remove(trash); // moves to the Recycle Bin
		const ab = await db.save();
		return Buffer.from(ab);
	};
	for (const [label, v3] of [["KDBX4/Argon2id", false], ["KDBX3/AES-KDF", true]] as const) {
		writeFileSync(join(root, "db.kdbx"), await make({ v3 }));
		const kp = new Keepass(cfg());
		const n = await kp.unlock("pw-two");
		ok(`${label}：解锁；回收站条目不可见`, n === 3 && kp.search("trashed").total === 0, String(n));
		const ssh = kp.search("ssh box").results[0]!;
		ok(`${label}：附件作为文本取出（SSH 私钥）`, kp.get(`kp:${ssh.id}#attachment:id_fake`).value.startsWith("-----BEGIN FAKE KEY-----\nabcdef") && ssh.extra.includes("attachment:id_fake"));
		ok(`${label}：二进制附件被拒绝`, await throwsCode(() => kp.get(`kp:${kp.search("binary").results[0]!.id}#attachment:blob.bin`), "bad-field"));
		const ko = kp.search("keeotp").results[0]!;
		ok(`${label}：KeeOtp 的 TimeOtp-* 字段也能出码`, ko.hasTotp && /^\d{6}$/.test(kp.get(`kp:${ko.id}#totp`).value));
		kp.lock();
	}
}


section("KeePassXC 官方实现生成的数据库（KDBX4）——与 KeePassXC 自己的输出逐项对照");
{
	const XC = fileURLToPath(new URL("./fixtures/keepassxc-real.kdbx", import.meta.url)), XPW = "KpxcMaster-pw ünï 456!";
	copyFileSync(XC, join(root, "db.kdbx"));
	// 参考值来自同一文件上的 `keepassxc-cli show -s` / `show -t`（见 fixtures/README.md）
	const T0 = 1793578960_000; // inside the 30 s / 60 s windows in which keepassxc-cli printed the codes below
	let now = T0;
	const kp = new Keepass(cfg(), { now: () => now });
	ok("KeePassXC 生成的文件能用主密码解锁；Bank(隐藏)与回收站不计入 → 5 条可见", (await kp.unlock(XPW)) === 5 && kp.entryCount === 5);
	ok("回收站里的 Trashed 搜不到", kp.search("trashed").total === 0 && kp.search("bank").total === 0);
	const gh = kp.search("github").results[0]!, staging = kp.search("staging").results[0]!, legacy = kp.search("legacy").results[0]!, s256 = kp.search("sha256").results[0]!, empty = kp.search("empty").results[0]!;
	ok("标题/用户/网址/标签与 KeePassXC 显示一致", gh.username === "alice" && gh.url === "https://github.com/login" && gh.tags.join() === "work" && staging.group === "Servers" && staging.tags.join() === "pitg-confirm,prod");
	ok("密码逐字节一致（引号、中文、换行）", kp.get(`kp:${gh.id}`).value === 'p@ss"w0rd ü 密码\nline2' && kp.get(`kp:${staging.id}`).value === "staging-pass-123");
	ok("自定义字段：受保护与不受保护都能取", kp.get(`kp:${staging.id}#API Key`).value === "custom-api-key-777" && kp.get(`kp:${staging.id}#Account number`).value === "12345678");
	ok("search 显示额外字段与附件名", ["API Key", "Account number", "attachment:id_ed25519", "attachment:photo.bin"].every((x) => staging.extra.includes(x)));
	ok("文本附件内容正确（55 字节，KeePassXC 报的也是 55.0 B）", (() => { const v = kp.get(`kp:${staging.id}#attachment:id_ed25519`).value; return v.length === 55 && v.startsWith("-----BEGIN FAKE KEY-----"); })());
	ok("二进制附件被拒绝", await throwsCode(() => kp.get(`kp:${staging.id}#attachment:photo.bin`), "bad-field"));
	ok("备注（含 recovery codes）无论如何都取不到", await throwsCode(() => kp.get(`kp:${gh.id}#notes`), "bad-field") && !JSON.stringify(kp.search("").results).includes("recovery"));
	ok("空密码字段 → 明确报错而不是返回空串", await throwsCode(() => kp.get(`kp:${empty.id}#password`), "bad-field"));
	// TOTP：对照 KeePassXC 自己算出的码
	const at = (ms: number, ref: string): string => { now = ms; return kp.get(ref).value; };
	ok("TOTP otpauth（GitHub，30 秒/6 位）= KeePassXC 的 555931", at(T0, `kp:${gh.id}#totp`) === "555931");
	ok("TOTP 旧格式 key=…&size=8&step=60 = KeePassXC 的 91372864", at(T0, `kp:${legacy.id}#totp`) === "91372864");
	ok("TOTP SHA256/8 位 = KeePassXC 的 36161920", at(T0, `kp:${s256.id}#totp`) === "36161920");
	ok("有效期剩余秒数合理", (() => { now = T0; const r = kp.get(`kp:${legacy.id}#totp`); return r.validForSec! >= 1 && r.validForSec! <= 60; })());
	kp.lock();
}

section("内存与稳定性保护");
{
	copyFileSync(FIXTURE, join(root, "db.kdbx"));
	const tight = new Keepass(cfg());
	setMemoryProbe(() => 100 * 1024 * 1024);
	let msg = ""; try { await tight.unlock(MASTER); } catch (e) { msg = (e as Error).message; ok("内存预检失败抛出 KeepassError(too-big)", e instanceof KeepassError && e.code === "too-big"); }
	ok("空闲内存不足：干净地拒绝（不会把整个 bot 撑到被 OOM 杀掉）", /not enough free memory/.test(msg) && !tight.unlocked, msg);
	setMemoryProbe(() => 8 * 1024 * 1024 * 1024);
	ok("内存充足时同一个库正常解锁", (await tight.unlock(MASTER)) === 2);
	tight.lock();
	const cap = new Keepass(cfg({ maxArgonMiB: 16 }));
	let capMsg = ""; try { await cap.unlock(MASTER); } catch (e) { capMsg = (e as Error).message; }
	ok("maxArgonMiB 上限：超过则拒绝并说明配置项", /safety limit/.test(capMsg) && /maxArgonMiB/.test(capMsg) && !cap.unlocked, capMsg);
	setMemoryProbe(null);
}

section("使用记录 / 预算 / 发现限制");
{
	const XC = fileURLToPath(new URL("./fixtures/keepassxc-real.kdbx", import.meta.url));
	copyFileSync(XC, join(root, "db.kdbx"));
	const kp = new Keepass(cfg({ maxEntriesPerSession: 2 }));
	await kp.unlock("KpxcMaster-pw ünï 456!");
	const ids = kp.search("").results.map((e) => e.id);
	ok("预算：没用过时不超", ids.every((id) => !kp.overBudget(id)));
	ok("noteUse：首次 first=true，同条目同字段再用 first=false，换字段又是 first", kp.noteUse(ids[0]!, "password").first && !kp.noteUse(ids[0]!, "PASSWORD").first && kp.noteUse(ids[0]!, "totp").first);
	kp.noteUse(ids[1]!, "password");
	ok("用满 2 个不同条目后：新条目超预算，已用过的不超", kp.overBudget(ids[2]!) && !kp.overBudget(ids[0]!) && kp.usedEntries === 2);
	kp.lock();
	await kp.unlock("KpxcMaster-pw ünï 456!");
	ok("重新锁定/解锁后预算清零", kp.usedEntries === 0 && !kp.overBudget(ids[2]!));
	kp.lock();

	// 空查询只给短页，防止一次性枚举
	const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("pw-many")), "many");
	db.setKdf(kdbxweb.Consts.KdfId.Argon2id); db.upgrade();
	for (let i = 0; i < 60; i++) { const e = db.createEntry(db.getDefaultGroup()); e.fields.set("Title", `site-${i}`); e.fields.set("UserName", `u${i}`); e.fields.set("Password", kdbxweb.ProtectedValue.fromString(`pw-${i}-xxxxxxxx`)); }
	writeFileSync(join(root, "db.kdbx"), Buffer.from(await db.save()));
	const many = new Keepass(cfg());
	await many.unlock("pw-many");
	ok("空查询：即使 limit=50 也只给 15 条（total 照实报告）", (() => { const r = many.search("", { limit: 50 }); return r.results.length === 15 && r.total === 60; })());
	ok("带关键词的查询可以到 50 条", many.search("site", { limit: 50 }).results.length === 50);
	many.lock();
}

section("文件安装 / 异常文件");
{
	const dir = join(root, "inst");
	const kp = new Keepass(cfg({ path: join(dir, "main.kdbx") }));
	ok("没文件时解锁 → no-file", await throwsCode(() => kp.unlock("x"), "no-file"));
	writeFileSync(join(root, "notkdbx.kdbx"), "this is definitely not a keepass database file");
	ok("安装前校验签名，拒绝非 KDBX", await throwsCode(() => kp.installFile(join(root, "notkdbx.kdbx")), "bad-file") && !existsSync(join(dir, "main.kdbx")));
	const r = kp.installFile(FIXTURE);
	ok("安装成功、权限 600、目录 700", r.bytes === statSync(FIXTURE).size && (statSync(join(dir, "main.kdbx")).mode & 0o777) === 0o600 && (statSync(dir).mode & 0o777) === 0o700);
	await kp.unlock(MASTER);
	const r2 = kp.installFile(FIXTURE);
	ok("再次安装：保留一份 .prev，并锁定旧的内存副本", r2.bytes > 0 && existsSync(join(dir, "main.kdbx.prev")) && !kp.unlocked);
	ok("没有残留的 .tmp", !existsSync(join(dir, "main.kdbx.tmp")));
	writeFileSync(join(dir, "main.kdbx"), Buffer.concat([readFileSync(FIXTURE).subarray(0, 200), Buffer.from("corrupt corrupt corrupt")]));
	ok("损坏的数据库 → bad-file（不是 wrong-password）", await throwsCode(() => kp.unlock(MASTER), "bad-file"));
	const big = new Keepass(cfg({ path: join(dir, "main.kdbx"), maxFileMb: 0.0001 }));
	ok("超大文件被拒", await throwsCode(() => big.unlock(MASTER), "too-big"));
}

section("擦除器：临时值");
{
	const s = new Scrubber();
	ok("无值时不活跃", !s.active);
	s.addEphemeral("kp:abc#password", 'p@ss"w0rd\nwith newline');
	ok("读取即开始擦除（含 JSON 转义形式）", s.active && !s.scrub('x p@ss"w0rd\nwith newline y').includes("p@ss") && !s.scrub(JSON.stringify('p@ss"w0rd\nwith newline')).includes("w0rd") && s.scrub('p@ss"w0rd\nwith newline').includes("[SECRET:kp:abc#password]"));
	s.addEphemeral("kp:abc#totp", "493827", 40);
	ok("TOTP 码在有效期内被擦除", !s.scrub("code 493827 sent").includes("493827"));
	await new Promise((r) => setTimeout(r, 80));
	ok("TOTP 码过期后不再误伤普通数字", s.scrub("code 493827 sent") === "code 493827 sent");
	ok("密码没有 TTL，仍在擦", !s.scrub('p@ss"w0rd\nwith newline').includes("p@ss"));
	for (let i = 0; i < 600; i++) s.addEphemeral(`kp:e${i}#password`, `value-number-${i}-xxxxxxxx`);
	ok("数量有上限，最旧的被淘汰（不会无限增长）", s.scrub("value-number-0-xxxxxxxx") === "value-number-0-xxxxxxxx" && !s.scrub("value-number-599-xxxxxxxx").includes("value-number-599"));
}

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nKeePass 模块验证通过" : `\n${fail} 处不符`);
process.exit(fail === 0 ? 0 : 1);
