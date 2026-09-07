import assert from "node:assert/strict";
import { Dispatcher } from "../src/agent/dispatcher.ts";
const tick = () => new Promise((r) => setTimeout(r, 10));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
function setup(prompt: (d: Dispatcher, s: any) => Promise<void>, finish?: () => Promise<unknown>) {
	let d!: Dispatcher; const finals: string[] = [], events: string[] = [];
	const s: any = { isStreaming: false, async prompt() { events.push("prompt"); await prompt(d, s); }, async steer() {}, async abort() {} };
	const host = { session: s, async reset() { events.push("reset"); } };
	d = new Dispatcher({ host, log, idleTimeoutMs: 100000,
		createLive: () => ({ setPrompt() {}, async begin() {}, stats: { messageId: 1 }, async finish(text: string) { finals.push(text); await finish?.(); return { complete: true }; } }) as any,
		onBegin: () => events.push("begin"), onEnd: () => events.push("end") });
	return { d, s, host, events, finals };
}
const item = { text: "test", chatId: 1, replyTo: 1 };
// No-model commands/input handled paths release immediately.
{
	const h = setup(async () => {}); h.d.enqueue(item); await tick(); assert(!h.d.busy);
	h.d.enqueue(item); await tick(); assert.equal(h.events.filter((e) => e === "prompt").length, 2);
}
// A real run waits for agent_settled AND delivery even if prompt returns first.
{
	const gate = deferred(); const h = setup(async (d) => { d.markStarted(); }, () => gate.promise);
	h.d.enqueue(item); await tick(); assert(h.d.busy); assert.equal(h.finals.length, 0);
	h.d.markSettled("answer"); await tick(); assert(h.d.busy); assert(h.d.current);
	h.d.enqueue(item); assert.equal(h.events.filter((e) => e === "prompt").length, 1);
	gate.resolve(); await tick(); assert.equal(h.events.filter((e) => e === "prompt").length, 2);
	h.d.markSettled("second"); await tick(); assert(!h.d.busy);
}
// Reset aborts the old run with subscription intact, waits delivery, then replaces.
{
	const running = deferred(), delivery = deferred(); const h = setup(async (d, s) => { s.isStreaming = true; d.markStarted(); await running.promise; }, () => delivery.promise);
	h.s.abort = async () => { h.events.push("abort"); h.s.isStreaming = false; h.d.markSettled("aborted"); running.resolve(); };
	h.d.enqueue(item); await tick(); const reset = h.d.reset(); const duplicate = h.d.reset(); assert.equal(reset, duplicate);
	await tick(); assert(!h.events.includes("reset")); assert(h.d.busy);
	delivery.resolve(); await reset; assert.deepEqual(h.events.slice(-3), ["abort", "end", "reset"]); assert(!h.d.busy);
}
// Reset in placeholder/preflight must not allow work to slip into old generation.
{
	const gate = deferred(); const h = setup(async (d, s) => { await gate.promise; s.isStreaming = true; d.markStarted(); });
	h.s.abort = async () => { if (h.s.isStreaming) { h.s.isStreaming = false; h.d.markSettled("aborted"); } };
	h.d.enqueue(item); await tick(); const reset = h.d.reset(); await tick(); gate.resolve(); await reset; assert(!h.d.busy);
}
// Different controls queue rather than accidentally sharing/dropping an action.
{
	const gate = deferred(); const h = setup(async () => {}); const order: string[] = [];
	const first = h.d.exclusive(async () => { order.push("first"); await gate.promise; });
	const second = h.d.exclusive(async () => { order.push("second"); });
	h.d.enqueue(item); await tick(); assert.deepEqual(order, ["first"]); assert.equal(h.events.length, 0);
	gate.resolve(); await Promise.all([first, second]); await tick();
	assert.deepEqual(order, ["first", "second"]); assert(h.events.includes("prompt")); assert(!h.d.busy);
}
console.log("Dispatcher regressions passed: handled commands, settled/delivery ownership, active reset, preflight reset and serialized controls.");
