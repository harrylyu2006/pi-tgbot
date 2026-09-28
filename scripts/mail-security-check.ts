import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");
const MailMessage = require("nodemailer/lib/mailer/mail-message");
const parserRequire = createRequire(require.resolve("mailparser"));
// Mail parsing must not retain a second, vulnerable copy of Nodemailer.
assert.equal(parserRequire.resolve("nodemailer"), require.resolve("nodemailer"));

const root = mkdtempSync(join(tmpdir(), "pi-tg-mail-security-"));
try {
	const attachment = join(root, "attachment.txt");
	const content = "Attachment roundtrip · 中文\n";
	writeFileSync(attachment, content);
	// No SMTP connection or credentials: compose MIME entirely in memory.
	const transport = nodemailer.createTransport({
		name: "offline-mime", version: "1", options: { disableUrlAccess: true },
		send(mail: any, done: (err: Error | null, info?: unknown) => void) {
			// Unlike StreamTransport (which deliberately preserves Bcc), use the
			// same default MIME behavior as SMTP without opening a connection.
			mail.message.build((err: Error | null, message: Buffer) => done(err, {
				message, envelope: mail.message.getEnvelope(), messageId: mail.message.messageId(),
			}));
		},
	});
	const result = await transport.sendMail({
		from: '"Sender 中文" <sender@example.com>',
		to: '"Recipient, One" <receiver@example.com>',
		cc: "copy@example.com",
		bcc: "hidden@example.com",
		subject: "MIME compatibility · 中文",
		text: "Plain body · 中文",
		html: "<p>HTML body · 中文</p>",
		inReplyTo: "<parent@example.com>",
		references: "<parent@example.com>",
		attachments: [{ path: attachment }],
	});
	assert.deepEqual(result.envelope.to, ["receiver@example.com", "copy@example.com", "hidden@example.com"]);
	const parsed = await simpleParser(result.message);
	assert.equal(parsed.subject, "MIME compatibility · 中文");
	assert(parsed.text.includes("Plain body · 中文"));
	assert(parsed.html.includes("HTML body · 中文"));
	assert.equal(parsed.to.value[0].address, "receiver@example.com");
	assert.equal(parsed.to.value[0].name, "Recipient, One");
	assert.equal(parsed.cc.value[0].address, "copy@example.com");
	assert.equal(parsed.bcc, undefined);
	assert.equal(parsed.inReplyTo, "<parent@example.com>");
	assert.equal(parsed.references, "<parent@example.com>");
	assert.equal(parsed.attachments.length, 1);
	assert.equal(parsed.attachments[0].content.toString(), content);

	const restricted = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
	const message = new MailMessage(restricted, {
		html: { path: attachment },
		attachments: [{ href: "http://127.0.0.1:9/blocked" }],
	});
	const resolveLegacy = (data: unknown, key: string | number): Promise<unknown> => new Promise((resolve, reject) => {
		message.resolveContent(data, key, (err: Error | null, value: unknown) => err ? reject(err) : resolve(value));
	});
	// GHSA-8m3c-c648-2xjj: legacy plugin calls must inherit access restrictions.
	await assert.rejects(() => resolveLegacy(message.data, "html"), { code: "EFILEACCESS" });
	await assert.rejects(() => resolveLegacy(message.data.attachments, 0), { code: "EURLACCESS" });
	await assert.rejects(() => restricted.sendMail({ from: "sender@example.com", to: "receiver@example.com", html: { path: attachment } }), { code: "EFILEACCESS" });
	console.log("Mail security regressions passed: MIME/attachments/threading, Bcc privacy, shared dependency and legacy access controls.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
