import { renderPanel } from "../src/ui/panel.ts";

const session = {
	model: { provider: "custom", id: "gpt-5.6-sol" },
	thinkingLevel: "high",
	sessionId: "1234567890abcdef",
	supportsThinking: () => true,
	getAvailableThinkingLevels: () => ["off", "low", "high", "max"],
	getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
	getSessionStats: () => ({ tokens: { total: 123 } }),
	getActiveToolNames: () => [],
	getAllTools: () => [],
};
const ctx = {
	host: { session, generation: 7 } as any,
	bootId: "boot",
	pollerState: () => "running" as const,
	busy: () => false,
	queueDepth: () => 0,
	uptimeMs: () => 1000,
	modelSpec: () => "custom/gpt-5.6-sol",
};
let failures = 0;
function ok(name: string, cond: boolean): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

console.log("/start 重启按钮：");
const status = await renderPanel(ctx, "status");
const statusButtons = status.markup.inline_keyboard.flat();
const restart = statusButtons.find((b) => b.text.includes("一键重启"));
ok("状态面板包含一键重启按钮", Boolean(restart));
ok("重启按钮先进入确认页", Boolean(restart?.callback_data?.includes("view")));

const confirm = await renderPanel(ctx, "confirm_restart");
const confirmButtons = confirm.markup.inline_keyboard.flat();
ok("确认页说明会保留模型和思考等级", confirm.text.includes("模型、思考等级"));
ok("确认页有确认重启按钮", confirmButtons.some((b) => b.text.includes("确认重启")));
ok("确认页有取消按钮", confirmButtons.some((b) => b.text === "取消"));

const busyConfirm = await renderPanel({ ...ctx, busy: () => true }, "confirm_restart");
ok("忙碌时明确警告当前任务会中断", busyConfirm.text.includes("当前任务会被中断"));

console.log(failures === 0 ? "\nPANEL CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
