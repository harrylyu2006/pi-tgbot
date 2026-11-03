import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedBots } from "../src/telegram/managed-bots.ts";
import type { TgUpdate } from "../src/telegram/types.ts";

const dir = mkdtempSync(join(tmpdir(), "managed-bot-check-"));
const token = ["123456789", "FAKE_ONLY_FOR_UNIT_TESTS_".repeat(2)].join(":");
const owner = { id: 42, is_bot: false, first_name: "operator" };
const bot = { id: 123456789, is_bot: true, first_name: "test", username: "sample_test_bot" };
const event: TgUpdate = { update_id: 1, managed_bot: { user: owner, bot } };
const service: TgUpdate = { update_id: 2, message: { message_id: 2, date: 1, chat: { id: 42, type: "private" }, from: owner, managed_bot_created: { bot } } };
const sent: any[] = [], notices: string[] = [], logs: unknown[] = [], audits: unknown[] = [];
const values = new Map<string, string>();
let tokenCalls = 0, enabled = true, fail = false;
const api = {
	getMe: async () => ({ ...bot, can_manage_bots: enabled }),
	sendMessage: async (params: unknown) => { sent.push(params); return { message_id: sent.length }; },
	call: async (method: string, params: any) => {
		assert.equal(method, "getManagedBotToken"); assert.equal(params.user_id, bot.id); tokenCalls++;
		if (fail) throw new Error(`private response ${token}`);
		return token;
	},
};
const log = { warn: (value: unknown) => logs.push(value) };
const deps = { api: api as never, log: log as never, secrets: {
	vault: { set: (name: string, value: string) => values.set(name, value) }, audit: (entry: unknown) => audits.push(entry),
} as never, operatorId: 42, path: join(dir, "bots.json"), notify: (text: string, replyTo: number) => { assert.ok(replyTo > 0); notices.push(text); } };
try {
	const manager = new ManagedBots(deps);
	await manager.request("测试", "sample_test_bot");
	assert.equal(sent[0].reply_markup.keyboard[0][0].request_managed_bot.suggested_username, "sample_test_bot");
	assert.equal(tokenCalls, 0, "sending a button does not create a bot or fetch its token");
	enabled = false;
	await assert.rejects(manager.request());
	enabled = true;
	await assert.rejects(manager.request("test", "not-a-bot"));
	await assert.rejects(manager.request("x".repeat(65), "sample_test_bot"));
	await manager.handle({ ...event, managed_bot: { user: { ...owner, id: 99 }, bot } });
	await manager.handle({ ...service, message: { ...service.message!, chat: { id: -100, type: "group" } } });
	assert.equal(tokenCalls, 0, "stranger and group notifications cannot fetch credentials");
	await Promise.all([manager.handle(event), manager.handle(service)]);
	assert.equal(values.get(`tg-managed-${bot.id}`), token);
	assert.equal(notices.length, 1, "paired notifications only notify once");
	assert.equal(manager.list().length, 1);
	assert.equal(statSync(deps.path).mode & 0o777, 0o600);
	assert.equal(new ManagedBots(deps).list()[0]?.id, bot.id);
	const publicOutputs = JSON.stringify({ sent, notices, logs, audits, registry: readFileSync(deps.path, "utf8") });
	assert.ok(!publicOutputs.includes(token), "token absent from all messages, notices, audit and registry");
	fail = true;
	await manager.handle(event);
	assert.ok(!JSON.stringify({ sent, notices, logs }).includes(token), "raw API errors never leak token");
	assert.ok(sent.at(-1).text.includes(`/syncbot ${bot.id}`));
	writeFileSync(join(dir, "broken.json"), "not json");
	assert.throws(() => new ManagedBots({ ...deps, path: join(dir, "broken.json") }));
	console.log("Managed bots checks passed: request/permission/validation, operator-only, dedupe, persistence, secret isolation, failure handling.");
} finally { rmSync(dir, { recursive: true, force: true }); }
