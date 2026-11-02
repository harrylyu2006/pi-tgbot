// Builds the KeePass 2 XML export that KeePassXC then converts into keepassxc-real.kdbx (see README.md). Fake data only.
//   node gen-keepassxc-xml.ts in.xml
import * as kdbxweb from "kdbxweb";
import { writeFileSync } from "node:fs";
import { argon2 } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(argon2);
kdbxweb.CryptoEngine.setArgon2Impl(async (pw, salt, mem, it, len, par, type) => {
	const o = await run(type === 2 ? "argon2id" : "argon2d", { message: Buffer.from(pw), nonce: Buffer.from(salt), parallelism: par, tagLength: len, memory: mem, passes: it });
	return o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) as ArrayBuffer;
});
const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("x")), "KPXC conformance");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id); db.upgrade();
const root = db.getDefaultGroup();
const P = (s: string): kdbxweb.ProtectedValue => kdbxweb.ProtectedValue.fromString(s);
const mk = (grp: kdbxweb.KdbxGroup, title: string, user: string, pass: string, url = "", tags: string[] = []): kdbxweb.KdbxEntry => {
	const e = db.createEntry(grp); e.fields.set("Title", title); e.fields.set("UserName", user); e.fields.set("Password", P(pass)); e.fields.set("URL", url); e.tags = tags; return e;
};
const gh = mk(root, "GitHub", "alice", 'p@ss"w0rd ü 密码\nline2', "https://github.com/login", ["work"]);
gh.fields.set("otp", P("otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&period=30&digits=6"));
gh.fields.set("Notes", "recovery codes: AAAA-BBBB (must never be exposed)");
mk(root, "Legacy KeeOtp", "old", "legacy-pass-1").fields.set("otp", P("key=JBSWY3DPEHPK3PXP&size=8&step=60"));
mk(root, "Sha256 Otp", "s", "sha256-pass-1").fields.set("otp", P("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8"));
const servers = db.createGroup(root, "Servers");
const box = mk(servers, "Staging root", "root", "staging-pass-123", "ssh://203.0.113.10", ["pitg-confirm", "prod"]); // documentation address
box.fields.set("API Key", P("custom-api-key-777")); box.fields.set("Account number", "12345678");
box.binaries.set("id_ed25519", await db.binaries.add(new TextEncoder().encode("-----BEGIN FAKE KEY-----\nabcdef\n-----END FAKE KEY-----\n")));
box.binaries.set("photo.bin", await db.binaries.add(new Uint8Array([0, 1, 2, 255, 0])));
mk(root, "Bank", "me", "bank-top-secret-1", "https://bank.example", ["pitg-hidden"]);
mk(root, "Empty pw", "nopass", "");
db.remove(mk(root, "Trashed", "t", "trashed-pass-1")); // moves to the Recycle Bin
writeFileSync(process.argv[2] ?? "in.xml", await db.saveXml(true));
