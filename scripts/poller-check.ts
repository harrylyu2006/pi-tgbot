import { Poller } from "../src/telegram/poller.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}
const noop = (): void => {};
const poller = new Poller({} as never, { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } } as never, {
	allowedUserId: 42,
	commands: [],
	onUpdate: noop,
	onFatal: noop,
});
const accept = (update: unknown): boolean => (poller as unknown as { accept(value: unknown): boolean }).accept(update);
const user = { id: 42, is_bot: false, first_name: "operator" };

console.log("单用户私聊边界：");
ok("接受操作员私聊消息", accept({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, from: user, text: "hi" } }));
ok("拒绝其他用户私聊", !accept({ update_id: 2, message: { message_id: 2, date: 1, chat: { id: 99, type: "private" }, from: { ...user, id: 99 }, text: "hi" } }));
ok("拒绝操作员在群里的消息", !accept({ update_id: 3, message: { message_id: 3, date: 1, chat: { id: -100123, type: "supergroup" }, from: user, text: "hi" } }));
ok("拒绝群消息上的 callback", !accept({ update_id: 4, callback_query: { id: "q", from: user, data: "x", message: { message_id: 4, date: 1, chat: { id: -100123, type: "supergroup" } } } }));

console.log(failures === 0 ? "\nPOLLER CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
