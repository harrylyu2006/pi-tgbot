import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramApi } from "../src/telegram/api.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-tg-upload-"));
const path = join(dir, 'a"b.txt');
const payload = "stream-me\n".repeat(2000);
writeFileSync(path, payload);

let body = Buffer.alloc(0);
let contentType = "";
const server = http.createServer((req, res) => {
	contentType = String(req.headers["content-type"] ?? "");
	const chunks: Buffer[] = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		body = Buffer.concat(chunks);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ ok: true, result: { message_id: 7, date: 0, chat: { id: 1, type: "private" } } }));
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");

const noop = (): void => {};
const api = new TelegramApi(`12345678:${"A".repeat(30)}`, { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } });
(api as unknown as { base: string }).base = `http://127.0.0.1:${address.port}/bot-test`;
const result = await api.sendFile(1, path, "document", "caption");
server.close();
rmSync(dir, { recursive: true, force: true });

const text = body.toString("utf8");
const checks = [
	["返回 Telegram 结果", result.message_id === 7],
	["multipart content-type", /^multipart\/form-data; boundary=/.test(contentType)],
	["文件内容完整", text.includes(payload)],
	["caption 已编码", text.includes("caption")],
	["文件名移除引号", text.includes('filename="a_b.txt"')],
] as const;
let failures = 0;
for (const [name, passed] of checks) {
	if (!passed) failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${name}`);
}
console.log(failures === 0 ? "\nUPLOAD CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
