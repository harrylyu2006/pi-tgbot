import { cumulativeThinking, toolActivityDetail, createEventRouter } from "../src/agent/events.ts";
import { LiveMessage } from "../src/telegram/live.ts";

let failures = 0;
function check(name: string, got: string, want: string): void {
	const ok = got === want;
	if (!ok) failures++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}
function checkContains(name: string, got: string, want: string): void {
	const ok = got.includes(want);
	if (!ok) failures++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}
function checkNotContains(name: string, got: string, forbidden: string): void {
	const ok = !got.includes(forbidden);
	if (!ok) failures++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      不应包含 ${JSON.stringify(forbidden)}`}`);
}

interface RouterHarness {
	send(type: string, extra?: Record<string, unknown>): void;
	activities: string[];
	thinking: string[];
	started: string[];
	order: string[];
}

/** A wired router with a recording sink, for lifecycle-level assertions. */
function harness(): RouterHarness {
	const activities: string[] = [];
	const thinking: string[] = [];
	const started: string[] = [];
	const order: string[] = [];
	const gen = 1;
	const noop = (): void => {};
	const route = createEventRouter({
		log: { debug: noop, info: noop, warn: noop, error: noop, child: () => ({ debug: noop, info: noop, warn: noop, error: noop, child: () => ({} as never) }) },
		sink: {
			onStart: noop,
			onAnswer: noop,
			onThinking: (text: string) => thinking.push(text),
			onActivity: (line: string) => {
				activities.push(line);
				order.push("activity");
			},
			onSettled: noop,
		},
		tools: {
			start: (info: { toolCallId: string }) => {
				started.push(info.toolCallId);
				order.push(`audit:${info.toolCallId}`);
			},
			end: noop,
		},
		currentGeneration: () => gen,
	});
	return {
		activities,
		thinking,
		started,
		order,
		send: (type: string, extra: Record<string, unknown> = {}) => route(gen, { type, ...extra }),
	};
}

console.log("工具活动详情（每个条目 ≤ 2 物理行 = 标题行 + 折叠明细行）：");
check("bash 单行", toolActivityDetail("bash", { command: "git status --short" }), "git status --short");
check(
	"bash 多行折叠为单行并加省略号",
	toolActivityDetail("bash", { command: "echo first\necho second\necho third\necho fourth" }),
	"echo first │ echo second …",
);
check("bash 恰好两行不加省略号", toolActivityDetail("bash", { command: "echo first\necho second" }), "echo first │ echo second");
check("read 路径和范围", toolActivityDetail("read", { path: "/srv/app/main.ts", offset: 20, limit: 50 }), "/srv/app/main.ts · 行 20 起，最多 50 行");
check("edit 只报路径和数量", toolActivityDetail("edit", { path: "/srv/app/main.ts", edits: [{}, {}] }), "/srv/app/main.ts · 2 处修改");
check("write 不展示正文", toolActivityDetail("write", { path: "/tmp/report.md", content: "secret body" }), "/tmp/report.md · 写入 11 个字符");
check("grep 模式和路径", toolActivityDetail("grep", { pattern: "TODO|FIXME", path: "src" }), "/TODO|FIXME/ · src");
check("find 模式和路径", toolActivityDetail("find", { pattern: "**/*.ts", path: "src" }), "**/*.ts · src");
check("扩展工具只取两个标量", toolActivityDetail("custom", { path: "/tmp/a", mode: "fast", nested: { secret: true }, third: 3 }), "path: /tmp/a · mode: fast");
checkNotContains("扩展工具跳过敏感键", toolActivityDetail("custom", { api_key: "not-a-real-secret", query: "safe" }), "not-a-real-secret");
checkNotContains("明细本身不含换行", toolActivityDetail("bash", { command: "a\nb\nc" }), "\n");

console.log("生命周期：");
{
	const h = harness();
	h.send("agent_start");
	h.send("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "sleep 5" } });
	const startedLine = h.activities[h.activities.length - 1] ?? "";
	checkContains("工具开始显示名称", startedLine, "⏳ bash");
	checkContains("工具开始显示命令预览", startedLine, "sleep 5");
	// 每项 ≤ 2 行：标题 + 明细
	check("运行中条目恰好两行", startedLine.split("\n").length === 2 ? "2 行" : `${startedLine.split("\n").length} 行`, "2 行");
	h.send("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	checkContains("工具完成状态可见", h.activities[h.activities.length - 1] ?? "", "✅ bash 完成");
	h.send("agent_start");
	check("agent_start 清空活动", h.activities[h.activities.length - 1] ?? "", "");
}

console.log("错误状态与审计顺序：");
{
	const h = harness();
	h.send("agent_start");
	h.send("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "rm -rf /tmp/x" } });
	h.send("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: true });
	checkContains("工具失败状态可见", h.activities[h.activities.length - 1] ?? "", "⚠️ bash 失败");
	// audit.start 必须在任何活动推送之前记录
	check("audit start 先于活动推送", h.order.slice(0, 2).join(" "), "audit:t1 activity");
}

console.log("工具更新（累计 partialResult 只展示有界尾部）：");
{
	const h = harness();
	h.send("agent_start");
	h.send("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	h.send("tool_execution_update", {
		toolCallId: "t1",
		toolName: "bash",
		args: {},
		partialResult: { content: [{ type: "text", text: "编译中…\n42 个用例通过" }] },
	});
	const updated = h.activities[h.activities.length - 1] ?? "";
	checkContains("更新显示最新输出行", updated, "42 个用例通过");
	checkNotContains("不倾倒全部输出", updated, "编译中…");
	h.send("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false });
}

console.log("并发工具按 toolCallId 关联：");
{
	const h = harness();
	h.send("agent_start");
	h.send("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/a.ts" } });
	h.send("tool_execution_start", { toolCallId: "t2", toolName: "grep", args: { pattern: "TODO" } });
	const both = h.activities[h.activities.length - 1] ?? "";
	checkContains("并发时显示最新工具", both, "⏳ grep");
	checkContains("并发时显示并行计数", both, "＋1 并行");
	h.send("tool_execution_end", { toolCallId: "t1", toolName: "read", result: {}, isError: false });
	const after = h.activities[h.activities.length - 1] ?? "";
	checkContains("t1 结束不影响仍在运行的 t2", after, "⏳ grep");
	checkNotContains("并行计数随 t1 结束归零", after, "＋1 并行");
	h.send("tool_execution_end", { toolCallId: "t2", toolName: "grep", result: {}, isError: false });
}

console.log("模型阶段（思考/工具参数/回复）：");
{
	const h = harness();
	h.send("agent_start");
	h.send("message_update", {
		message: { content: [{ type: "thinking", thinking: "先检查配置" }] },
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先检查配置" },
	});
	const thinking = h.activities[h.activities.length - 1] ?? "";
	checkContains("思考阶段可见", thinking, "💭 思考中…");
	check("真实思考内容转发到 sink", h.thinking[h.thinking.length - 1] ?? "", "先检查配置");
	check("累计思考提取多块内容", cumulativeThinking({ content: [{ type: "thinking", thinking: "A" }, { type: "text", text: "x" }, { type: "thinking", thinking: "B" }] }), "AB");
	check("不转发 redacted thinking", cumulativeThinking({ content: [{ type: "thinking", thinking: "opaque", redacted: true }] }), "");
	h.send("message_end", { message: { content: [{ type: "thinking", thinking: "最终完整思考" }] } });
	check("message_end 补抓非流式思考", h.thinking[h.thinking.length - 1] ?? "", "最终完整思考");
	h.send("message_update", {
		message: { content: [{ type: "toolCall", id: "planned", name: "bash", arguments: { command: "npm" } }] },
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: " test",
			partial: { content: [{ type: "toolCall", id: "planned", name: "bash", arguments: { command: "npm test" } }] },
		},
	});
	const building = h.activities[h.activities.length - 1] ?? "";
	checkContains("工具参数生成中立即显示具体工具", building, "🔧 即将调用 bash");
	checkContains("工具参数生成中显示当前命令", building, "npm test");
	h.send("message_update", {
		message: { content: [] },
		assistantMessageEvent: {
			type: "toolcall_end",
			toolCall: { type: "toolCall", id: "planned", name: "bash", arguments: { command: "npm test" } },
		},
	});
	const planned = h.activities[h.activities.length - 1] ?? "";
	checkContains("工具参数完成后显示具体工具", planned, "🔧 即将调用 bash");
	checkContains("工具参数完成后显示具体命令", planned, "npm test");
	checkNotContains("不显示无信息的准备调用占位", planned, "准备调用工具");
	h.send("message_update", { message: { content: [{ type: "text", text: "看完了" }] }, assistantMessageEvent: { type: "text_delta", delta: "看完了" } });
	const responding = h.activities[h.activities.length - 1] ?? "";
	checkNotContains("正文出现后不再占用活动行", responding, "💭 思考中…");
}

console.log("队列预览：");
{
	const h = harness();
	h.send("agent_start");
	h.send("queue_update", { steering: ["检查所有服务器的磁盘占用"], followUp: ["把结果整理成表格"] });
	const queued = h.activities[h.activities.length - 1] ?? "";
	checkContains("steering 队列预览", queued, "⏭ 队列（1）：检查所有服务器的磁盘占用");
	checkContains("followUp 队列预览", queued, "📌 后续：把结果整理成表格");
}

console.log("重试与压缩：");
{
	const h = harness();
	h.send("agent_start");
	h.send("auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "upstream 503" });
	checkContains("自动重试可见", h.activities[h.activities.length - 1] ?? "", "↻ 自动重试中（1/3）");
	h.send("auto_retry_end", { success: true, attempt: 1 });
	h.send("compaction_start", { reason: "threshold" });
	checkContains("压缩上下文可见", h.activities[h.activities.length - 1] ?? "", "🧹 正在压缩上下文…");
	h.send("compaction_end", { reason: "threshold", result: undefined, aborted: false, willRetry: false });
	h.send("summarization_retry_scheduled", { attempt: 2, maxAttempts: 4, delayMs: 500, errorMessage: "529" });
	checkContains("摘要重试可见", h.activities[h.activities.length - 1] ?? "", "↻ 摘要重试中（2/4）");
	h.send("summarization_retry_finished");
}

console.log("活动块整体封顶：");
{
	const h = harness();
	h.send("agent_start");
	h.send("auto_retry_start", { attempt: 1, maxAttempts: 3 });
	h.send("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "a\nb\nc" } });
	h.send("tool_execution_start", { toolCallId: "t2", toolName: "read", args: { path: "/x.ts" } });
	h.send("queue_update", { steering: ["排队消息"], followUp: ["后续消息"] });
	const busy = h.activities[h.activities.length - 1] ?? "";
	check("忙时活动块不超过 5 行", busy.split("\n").length <= 5 ? "是" : `${busy.split("\n").length} 行`, "是");
	checkNotContains("块内条目明细无换行溢出", busy, "a │ b\nc");
}

console.log("出站脱敏与思考渲染：");
const live = new LiveMessage({} as never, {} as never, {
	chatId: 1,
	editThrottleMs: 1000,
	maxChars: 3800,
	maxEditsPerTurn: 1,
	notifyAfterMs: 30_000,
});
live.setActivity("bash\ntoken=" + "1234567890:" + "AAFAKEfaketokenfortestingonly1234567");
const activity = (live as unknown as { activity: string }).activity;
checkContains("活动命令出站脱敏", activity, "REDACTED");
checkNotContains("脱敏不泄露 token", activity, "AAFAKE");
live.setThinking("先读取 `/root/app.ts`，然后检查配置");
const composed = (live as unknown as { compose(): string }).compose();
checkContains("思考过程显示独立标题", composed, "💭 思考过程");
checkContains("思考过程使用可折叠引用", composed, "<blockquote expandable>");
checkContains("思考过程保留 Markdown 代码格式", composed, "<code>/root/app.ts</code>");

console.log("编辑上限不冻结真实内容：");
{
	const edits: string[] = [];
	const fakeApi = {
		sendMessage: async () => ({ message_id: 10 }),
		editMessageText: async (params: { text: string }) => {
			edits.push(params.text);
			return {};
		},
	};
	const capped = new LiveMessage(fakeApi as never, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never, {
		chatId: 1,
		editThrottleMs: 0,
		maxChars: 3800,
		maxEditsPerTurn: 0,
		notifyAfterMs: 30_000,
	});
	await capped.begin();
	capped.setActivity("普通状态变更");
	await new Promise((resolve) => setTimeout(resolve, 10));
	check("超过软上限后跳过纯状态编辑", String(edits.length), "0");
	capped.setThinking("仍在生成新的思考 token");
	await new Promise((resolve) => setTimeout(resolve, 10));
	check("超过软上限后仍发送真实思考内容", String(edits.length), "1");
	capped.setAnswer("正文 token");
	await new Promise((resolve) => setTimeout(resolve, 10));
	check("超过软上限后仍发送真实正文内容", String(edits.length), "2");
}

console.log(failures === 0 ? "\nACTIVITY CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
