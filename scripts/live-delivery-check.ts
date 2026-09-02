import assert from "node:assert/strict";
import { TgError } from "../src/errors.ts";
import { LiveMessage } from "../src/telegram/live.ts";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as any;

async function testRetryThenReceipt(): Promise<void> {
  const calls: string[] = [];
  let sends = 0;
  const api = {
    async sendMessage(input: any) {
      calls.push(`send:${input.text}`);
      sends++;
      if (sends === 2) throw new TgError("throttled", "rate limited", { retryAfter: 0 });
      return { message_id: sends };
    },
    async editMessageText(input: any) { calls.push(`edit:${input.text}`); return true; },
  } as any;
  const live = new LiveMessage(api, silentLog, { chatId: 1, editThrottleMs: 0, maxChars: 4096, maxEditsPerTurn: 100, notifyAfterMs: -1 });
  await live.begin("working");
  await live.finish("actual result");
  assert.equal(sends, 3, "429 must be retried");
  assert.match(calls.at(-1) ?? "", /结果已另发/);
  assert.ok(calls.some((x) => x === "send:actual result"));
}

async function testFailedSendPreservesExistingMessage(): Promise<void> {
  const edits: string[] = [];
  let sends = 0;
  const api = {
    async sendMessage() {
      sends++;
      if (sends === 1) return { message_id: 9 };
      throw new TgError("transient", "network down");
    },
    async editMessageText(input: any) { edits.push(input.text); return true; },
  } as any;
  const live = new LiveMessage(api, silentLog, { chatId: 1, editThrottleMs: 0, maxChars: 4096, maxEditsPerTurn: 100, notifyAfterMs: -1 });
  await live.begin("working");
  await live.finish("must survive");
  assert.equal(edits.at(-1), "must survive");
  assert.ok(!edits.some((x) => x.includes("结果见下")), "must never leave a lying receipt");
}

await testRetryThenReceipt();
await testFailedSendPreservesExistingMessage();
console.log("live delivery checks passed");
