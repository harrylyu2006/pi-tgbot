import assert from "node:assert/strict";
import { syncCommandMenu } from "../src/telegram/menu.ts";
import { COMMANDS } from "../src/telegram/commands.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import { readFileSync } from "node:fs";

const key = (p: any) => `${p.scope.type}:${p.scope.chat_id ?? ""}:${p.language_code ?? ""}`;
const menus = new Map<string, any[]>([
	["all_private_chats::", [{ command: "egress", description: "old bot" }]],
	["chat:42:en", [{ command: "old", description: "old localized menu" }]],
]);
const writes: string[] = [];
const api: any = {
	async getMyCommands(p: any) { return menus.get(key(p)) ?? []; },
	async setMyCommands(commands: any[], _signal: unknown, p: any) { writes.push(key(p)); menus.set(key(p), commands); return true; },
	async deleteMyCommands() { throw new Error("must replace rather than delete"); },
};
await syncCommandMenu(api, 42, COMMANDS);
assert.equal(writes.length, 9);
assert(writes[0]!.startsWith("chat:42:"), "fix highest-priority scope first");
for (const type of ["chat:42", "all_private_chats:", "default:"]) {
	for (const language of ["", "en", "zh"]) assert.deepEqual(menus.get(`${type}:${language}`), COMMANDS);
}
await syncCommandMenu(api, 42, COMMANDS);
assert.equal(writes.length, 9, "already current menus need no writes");
await assert.rejects(() => syncCommandMenu({ ...api, async getMyCommands() { return []; }, async setMyCommands() { return true; } }, 42, COMMANDS), /verification/);
const controller = new AbortController(); controller.abort(new Error("cancelled"));
await assert.rejects(() => syncCommandMenu(api, 42, COMMANDS, controller.signal), /cancelled/);
const fakeLog: any = { debug() {}, info() {}, warn() {}, error() {} };
const transport = new TelegramApi("unused", fakeLog); const calls: any[] = [];
(transport as any).call = async (method: string, params: any) => { calls.push({ method, params }); return true; };
await transport.setMyCommands(COMMANDS, undefined, { scope: { type: "all_private_chats" }, language_code: "en" });
assert.equal(calls[0].params.scope.type, "all_private_chats"); assert.equal(calls[0].params.language_code, "en");
// Published menu commands must remain handled by the daemon rather than sent to AI.
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
for (const c of COMMANDS) assert(main.includes(`"/${c.command}"`), `unhandled advertised command ${c.command}`);
console.log("Menu regressions passed: private scope precedence, localized menus, verification, idempotence and command handlers.");
