/** confirm() 的三条失败路径都必须返回 false（拒绝）。 */
import { TelegramUI } from "../src/ui/telegram-ui.ts";
import { createLogger, setLevel } from "../src/log.ts";
setLevel("error");
const log = createLogger("test");
let fails = 0;
const check = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}: got ${got}, want ${want}`);
};

// 1) 超时未响应 → 拒绝
const uiTimeout = new TelegramUI({
  api: { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => true } as any,
  log, bootId: "t", currentChatId: () => 123, generation: () => 1, timeoutMs: 300,
});
check("超时未点按钮", await uiTimeout.confirm("危险命令", "rm -rf /"), false);

// 2) 提问消息都发不出去 → 拒绝（不能当作同意）
const uiSendFail = new TelegramUI({
  api: { sendMessage: async () => { throw new Error("network down"); } } as any,
  log, bootId: "t", currentChatId: () => 123, generation: () => 1, timeoutMs: 300,
});
check("提问发送失败", await uiSendFail.confirm("危险命令", "sudo rm"), false);

// 3) 不在任何一轮任务中（无归属 chat）→ 拒绝
const uiNoChat = new TelegramUI({
  api: { sendMessage: async () => ({ message_id: 1 }) } as any,
  log, bootId: "t", currentChatId: () => null, generation: () => 1, timeoutMs: 300,
});
check("无归属会话", await uiNoChat.confirm("危险命令", "mkfs"), false);

// 4) 点了「允许」→ 通过；点了「拒绝」→ 拒绝
for (const [idx, want, name] of [["0", true, "点了允许"], ["1", false, "点了拒绝"]] as const) {
  const ui = new TelegramUI({
    api: { sendMessage: async () => ({ message_id: 9 }), editMessageText: async () => true } as any,
    log, bootId: "t", currentChatId: () => 123, generation: () => 1, timeoutMs: 5000,
  });
  const p = ui.confirm("危险命令", "rm -rf x");
  await new Promise(r => setTimeout(r, 50));
  ui.resolve(`1:${idx}`);
  check(name, await p, want);
}

console.log(fails === 0 ? "\nFAIL-CLOSED 验证通过" : `\n${fails} 处不符合预期`);
process.exit(fails === 0 ? 0 : 1);
