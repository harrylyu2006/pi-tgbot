import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventRouter } from "../src/agent/events.ts";
import { LiveMessage } from "../src/telegram/live.ts";
import { DeliveryStore, retryPendingDelivery, sendChunk } from "../src/telegram/delivery.ts";
import { TgError } from "../src/errors.ts";
import { compileBlocks } from "../src/telegram/markdown.ts";
import { packBlocks, packTail } from "../src/telegram/chunk.ts";
import { stripTags } from "../src/telegram/html.ts";
import { TelegramApi } from "../src/telegram/api.ts";
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const opts = { chatId: 1, editThrottleMs: 10000, maxChars: 3800, maxEditsPerTurn: 1, notifyAfterMs: Infinity, wait: async () => {} };
const tick = () => new Promise((r) => setTimeout(r, 5));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const root = mkdtempSync(join(tmpdir(), "pi-tg-delivery-test-"));
try {
	// Normal SDK roles: neither tool text nor custom notifications reach answers.
	const answers: string[] = [], finals: string[] = [];
	const route = createEventRouter({ log, currentGeneration: () => 1, sink: { onStart() {}, onAnswer: (x) => answers.push(x), onThinking() {}, onActivity() {}, onSettled: (x) => finals.push(x) } });
	route(1, { type: "agent_start" });
	for (const role of ["user", "toolResult", "custom", "bashExecution"]) {
		for (const type of ["message_start", "message_update", "message_end"]) route(1, { type, message: { role, content: [{ type: "text", text: "PRIVATE_TOOL_PAYLOAD" }] } });
	}
	assert.equal(answers.length, 0);
	route(1, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "PRIVATE_REQUEST_BODY" } });
	route(1, { type: "agent_settled" });
	assert.match(finals[0]!, /错误/); assert(!finals.join("").includes("PRIVATE"));
	route(0, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STALE" }] } });
	assert(!answers.includes("STALE"));

	// An old edit must finish first, then exactly one terminal writer wins.
	{
		const started = deferred(), release = deferred(); const edits: string[] = [];
		const api: any = { async sendMessage() { return { message_id: 1 }; }, async editMessageText(p: any) {
			if (p.text === "old partial") { started.resolve(); await release.promise; } edits.push(p.text); return true;
		} };
		const live = new LiveMessage(api, log, opts); await live.begin(); live.setAnswer("old partial");
		const flush = (live as any).flush(); await started.promise;
		const finishing = live.finish("FINAL"); assert.equal(live.finish("WRONG SECOND FINISH"), finishing);
		await tick(); assert.deepEqual(edits, []); release.resolve(); await flush; await finishing;
		assert.deepEqual(edits, ["old partial", "FINAL"]);
		await live.sealWith("shutdown"); assert.equal(edits.at(-1), "FINAL");
	}
	// Revision 2 arrives during revision 1's network await at the soft edit cap.
	{
		const release = deferred(), started = deferred(); const edits: string[] = [];
		const api: any = { async sendMessage() { return { message_id: 1 }; }, async editMessageText(p: any) {
			if (p.text === "first") { started.resolve(); await release.promise; } edits.push(p.text); return true;
		} };
		const live = new LiveMessage(api, log, opts); await live.begin(); live.setAnswer("first");
		const flush = (live as any).flush(); await started.promise; live.setAnswer("second"); release.resolve(); await flush;
		await (live as any).flush(); assert.deepEqual(edits, ["first", "second"]); await live.finish("second");
	}
	// Both short and long turns retry continuation 429 and finish all chunks.
	for (const notifyAfterMs of [-1, Infinity]) {
		let limited = false; const delivered: string[] = []; const waits: number[] = [];
		const api: any = { async sendMessage(p: any) {
			if (p.text.includes("TAIL") && !limited) { limited = true; throw new TgError("throttled", "limit", { retryAfter: 2 }); }
			delivered.push(p.text); return { message_id: 1 };
		}, async editMessageText(p: any) { delivered.push(p.text); return true; } };
		const live = new LiveMessage(api, log, { ...opts, maxChars: 80, notifyAfterMs, wait: async (ms) => { waits.push(ms); } });
		await live.begin(); const result = await live.finish("A".repeat(60) + "\n\nTAIL".repeat(12));
		assert(result.complete); assert(limited); assert(waits[0]! >= 2000); assert(delivered.some((x) => x.includes("TAIL")));
	}
	// Later failure is persisted, loadable after restart, replayed without a model.
	{
		const path = join(root, "delivery.json"); const store = new DeliveryStore(path); store.load(); let failed = true;
		const sent: string[] = []; const api: any = { async sendMessage(p: any) {
			if (p.text.includes("TAIL") && failed) throw new TgError("transient", "network down");
			sent.push(p.text); return { message_id: 1 };
		}, async editMessageText(p: any) { sent.push(p.text); return true; } };
		const live = new LiveMessage(api, log, { ...opts, maxChars: 80, notifyAfterMs: -1, deliveryStore: store });
		await live.begin(); const result = await live.finish("A".repeat(60) + "\n\n" + "TAIL".repeat(20));
		assert(!result.complete); assert.equal(result.delivered, 1); assert.equal(store.pending()[0]!.next, 1);
		assert(!sent.some((x) => x.includes("结果已另发"))); assert.equal(statSync(path).mode & 0o777, 0o600);
		const restarted = new DeliveryStore(path); restarted.load(); failed = false;
		await retryPendingDelivery(api, restarted, 1, async () => {}); assert.equal(restarted.pending().length, 0);
		assert.equal(sent.filter((x) => x === "A".repeat(60)).length, 1, "confirmed first chunk is not resent");
	}
	// Exhausted 429 budget retains later chunks; fallback errors are observable.
	{
		const store = new DeliveryStore(join(root, "exhausted.json")); store.load(); let attempts = 0;
		const api: any = { async sendMessage(p: any) {
			if (p.text.includes("TAIL")) { attempts++; throw new TgError("throttled", "limit", { retryAfter: 0 }); }
			return { message_id: 1 };
		}, async editMessageText() { return true; } };
		const live = new LiveMessage(api, log, { ...opts, maxChars: 80, deliveryStore: store });
		await live.begin(); const result = await live.finish("A".repeat(60) + "\n\n" + "TAIL".repeat(15));
		assert(!result.complete); assert.equal(attempts, 4); assert.equal(store.pending()[0]!.next, 1);
	}
	{
		const store = new DeliveryStore(join(root, "fallback-error.json")); store.load();
		const api: any = { async sendMessage() { throw new TgError("transient", "offline"); },
			async editMessageText(p: any) { throw new TgError(p.parse_mode ? "rejected" : "transient", p.parse_mode ? "can't parse entities" : "offline"); } };
		const live = new LiveMessage(api, log, { ...opts, existingMessageId: 1, deliveryStore: store });
		await live.begin(); const result = await live.finish("<not markup>");
		assert(!result.complete); assert.equal(result.delivered, 0); assert.equal(store.pending()[0]!.next, 0);
	}
	// Missing placeholder no longer truncates final to its first 200 characters.
	{
		const sent: string[] = [];
		const live = new LiveMessage({ async sendMessage(p: any) { sent.push(p.text); return { message_id: 1 }; } } as any, log, opts);
		await live.finish("x".repeat(8000)); assert.equal(sent.join(""), "x".repeat(8000));
	}
	// HTML fallback applies to send as well as edit, and failure isn't swallowed.
	{
		const calls: any[] = [];
		const api: any = { async sendMessage(p: any) { calls.push(p); if (p.parse_mode) throw new TgError("rejected", "can't parse entities"); return { message_id: 1 }; } };
		await sendChunk(api, 1, "<b>A &amp; B</b>", async () => {});
		assert.equal(calls[1].text, "A & B"); assert(!calls[1].parse_mode);
	}
	// Timeout retries must not duplicate non-idempotent sendMessage automatically.
	{
		const api = new TelegramApi("unused", log); let calls = 0;
		(api as any).callOnce = async () => { calls++; throw new TgError("transient", "timeout"); };
		await assert.rejects(() => api.sendMessage({ chat_id: 1, text: "test" })); assert.equal(calls, 1);
	}
	// Long formats/entities/surrogates: every piece valid and plain text lossless.
	for (const md of ["**" + "x".repeat(5000) + "**", "&<>🎉".repeat(2000), "> " + "x&🎉".repeat(2000),
		"```js\n" + "a & b < c\n".repeat(1500) + "```", "[" + "link".repeat(1500) + "](https://example.com/?a=1&b=2)"]) {
		const blocks = compileBlocks(md); const pieces = packBlocks(blocks, 3799);
		assert.equal(pieces.map(stripTags).join(""), blocks.map(stripTags).join(""));
		for (const piece of pieces) {
			assert(piece.length <= 3799); const stack: string[] = [];
			for (const match of piece.matchAll(/<(\/?)([\w-]+)(?:\s[^<>]*)?>/g)) {
				if (match[1]) assert.equal(stack.pop(), match[2]); else stack.push(match[2]!);
			}
			assert.equal(stack.length, 0);
			assert(!/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(piece.replace(/<[^>]*>/g, "")));
			assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(piece));
		}
		assert(packTail(blocks, 3799).length <= 3799);
	}
	const linked = compileBlocks('[**open**](https://example.com/?a=1&b=two__underscores__&q="x")').join("");
	assert(linked.includes('href="https://example.com/?a=1&amp;b=two__underscores__&amp;q=&quot;x&quot;"'));
	assert(linked.includes("<b>open</b>")); assert(!linked.includes("&amp;amp;"));
	assert.equal(compileBlocks('[`label`](https://example.com/?x=1&y=2)').join(""), '<a href="https://example.com/?x=1&amp;y=2"><code>label</code></a>');
	console.log("Reliability regressions passed: roles, privacy, edit ordering, delivery/outbox, retries, HTML and URLs.");
} finally { rmSync(root, { recursive: true, force: true }); }
