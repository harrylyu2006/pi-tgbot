/**
 * The /start operator panel.
 *
 * One message, navigated by editing it in place — a panel that spawns a new
 * message per tap buries the conversation it is supposed to be controlling.
 *
 * Model and thinking switches are refused while a turn is running rather than
 * applied mid-flight. Changing the model under a live turn is either ignored by
 * the SDK or corrupts the turn's own accounting, and "refused with a reason" is
 * a better contract than "maybe took effect".
 */

import { esc } from "../telegram/html.ts";
import { encodeCallback, grid, keyboard, type Button } from "../telegram/keyboard.ts";
import type { AgentHost } from "../agent/host.ts";
import type { PollerState } from "../telegram/poller.ts";

export interface PanelContext {
	host: AgentHost;
	bootId: string;
	pollerState: () => PollerState;
	busy: () => boolean;
	queueDepth: () => number;
	uptimeMs: () => number;
	modelSpec: () => string | undefined;
}

export interface PanelView {
	text: string;
	markup: ReturnType<typeof keyboard>;
}

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}秒`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}分${s % 60}秒`;
	const h = Math.floor(m / 60);
	return `${h}小时${m % 60}分`;
}

function nav(ctx: PanelContext, gen: number): Button[] {
	const cb = (action: string, arg = ""): string => encodeCallback(action, arg, ctx.bootId, gen);
	return [
		{ text: "📊 状态", data: cb("view", "status") },
		{ text: "📈 用量", data: cb("view", "tokens") },
		{ text: "🤖 模型", data: cb("view", "model") },
		{ text: "🧠 思考", data: cb("view", "think") },
		{ text: "🔧 工具", data: cb("view", "tools") },
	];
}

export async function renderPanel(ctx: PanelContext, view: string): Promise<PanelView> {
	const host = ctx.host;
	const session = host.session;
	const gen = host.generation;
	const cb = (action: string, arg = ""): string => encodeCallback(action, arg, ctx.bootId, gen);

	if (view === "model" || view.startsWith("model:")) {
		const runtime = (session as unknown as { modelRuntime: { getAvailable(p?: string): Promise<readonly any[]>; hasConfiguredAuth(p: string): boolean } }).modelRuntime;
		let models: readonly any[] = [];
		try {
			models = await runtime.getAvailable();
		} catch {
			models = [];
		}
		// 只显示已配置 API key 的渠道；openrouter 仅供内部多模态识图用，不在列表里展示
		models = models.filter((m) => m.provider !== "openrouter" && runtime.hasConfiguredAuth(m.provider));
		const current = `${session.model.provider}/${session.model.id}`;

		// 每页 8 个（4 行 × 2 列），超过则翻页：inline keyboard 不能滚动，
		// 按钮行数必须一屏放得下，否则底部导航会被挤出屏幕点不到。
		const PAGE_SIZE = 8;
		const total = models.length;
		const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
		const page = view.startsWith("model:") ? Number(view.slice(6)) || 0 : 0;
		const cur = Math.min(Math.max(page, 0), pages - 1);
		const pageModels = models.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

		const buttons: Button[] = pageModels.map((m) => ({ text: `${`${m.provider}/${m.id}` === current ? "✅ " : ""}${m.provider}/${m.id}`, data: cb("model", `${m.provider}/${m.id}`) }));
		const pager: Button[] = [];
		if (pages > 1) {
			if (cur > 0) pager.push({ text: "⬅️ 上一页", data: cb("mpage", String(cur - 1)) });
			if (cur < pages - 1) pager.push({ text: "下一页 ➡️", data: cb("mpage", String(cur + 1)) });
		}
		const lines = [
			"<b>🤖 模型</b>",
			"",
			`当前：<code>${esc(current)}</code>`,
			models.length === 0 ? "（读取可用模型失败）" : pages > 1 ? `可选 ${total} 个 · 第 ${cur + 1}/${pages} 页` : `可选 ${total} 个`,
			ctx.busy() ? "\n⚠️ 正在跑一轮任务，此时不能切换。" : "",
		];
		const rows = [...grid(buttons, 2), ...(pager.length > 0 ? [pager] : []), nav(ctx, gen)];
		return { text: lines.filter(Boolean).join("\n"), markup: keyboard(rows) };
	}

	if (view === "think") {
		const supported = session.supportsThinking();
		const levels = supported ? session.getAvailableThinkingLevels() : [];
		const buttons: Button[] = levels.map((l) => ({ text: `${l === session.thinkingLevel ? "✅ " : ""}${l}`, data: cb("think", l) }));
		const lines = [
			"<b>🧠 思考等级</b>",
			"",
			supported ? `当前：<code>${esc(session.thinkingLevel)}</code>` : "当前模型不支持思考等级。",
			ctx.busy() ? "\n⚠️ 正在跑一轮任务，此时不能切换。" : "",
		];
		return { text: lines.filter(Boolean).join("\n"), markup: keyboard([...grid(buttons, 3), nav(ctx, gen)]) };
	}

	if (view === "tools") {
		const active = session.getActiveToolNames();
		const all = session.getAllTools().map((t) => t.name);
		const inactive = all.filter((n) => !active.includes(n));
		const lines = [
			"<b>🔧 工具</b>",
			"",
			`启用（${active.length}）：<code>${esc(active.join(", "))}</code>`,
			inactive.length > 0 ? `未启用：<code>${esc(inactive.join(", "))}</code>` : "",
			"",
			"<i>只读视图。要停用某个工具，改配置里的 tools.deny 后重启服务。</i>",
		];
		return { text: lines.filter(Boolean).join("\n"), markup: keyboard([nav(ctx, gen)]) };
	}

	if (view === "tokens") {
		const stats = session.getSessionStats() as {
			tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
			cost?: number;
			userMessages?: number;
			assistantMessages?: number;
			toolCalls?: number;
			totalMessages?: number;
		};
		const t = stats.tokens ?? {};
		const n = (v: number | undefined): string => (v ?? 0).toLocaleString("en-US");
		const usage = session.getContextUsage();

		// Cumulative and current are different quantities and get separate blocks:
		// every turn resends the context, so cumulative input dwarfs context size,
		// and compaction makes context go *down* while cumulative keeps climbing.
		const lines = [
			"<b>📈 Token 用量</b>",
			"",
			"<b>本会话累计</b>",
			`<code>输入      ${n(t.input).padStart(12)}</code>`,
			`<code>输出      ${n(t.output).padStart(12)}</code>`,
			`<code>缓存读取  ${n(t.cacheRead).padStart(12)}</code>`,
			`<code>缓存写入  ${n(t.cacheWrite).padStart(12)}</code>`,
			`<code>合计      ${n(t.total).padStart(12)}</code>`,
		];
		// Cache hit rate is the number that actually explains the bill on a relay
		// with prompt caching, so surface it rather than making it inferable.
		const cacheable = (t.input ?? 0) + (t.cacheRead ?? 0);
		if (cacheable > 0 && (t.cacheRead ?? 0) > 0) {
			lines.push("", `缓存命中率：${(((t.cacheRead ?? 0) / cacheable) * 100).toFixed(1)}%`);
		}
		if ((stats.cost ?? 0) > 0) lines.push(`费用：$${(stats.cost ?? 0).toFixed(4)}`);
		lines.push(
			"",
			"<b>当前上下文</b>",
			`${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")}（${usage.percent.toFixed(2)}%）`,
			"",
			`消息：用户 ${stats.userMessages ?? 0} · 助手 ${stats.assistantMessages ?? 0} · 工具 ${stats.toolCalls ?? 0}`,
			`会话：<code>${esc(session.sessionId.slice(0, 8))}</code> · 第 ${gen} 代`,
		);
		return { text: lines.join("\n"), markup: keyboard([[{ text: "🔄 刷新", data: cb("view", "tokens") }], nav(ctx, gen)]) };
	}

	if (view === "confirm_new") {
		return {
			text: "<b>🆕 开新会话</b>\n\n当前会话的上下文会被丢弃，无法恢复。确定？",
			markup: keyboard([
				[
					{ text: "✅ 确定", data: cb("do_new") },
					{ text: "取消", data: cb("view", "status") },
				],
			]),
		};
	}

	if (view === "confirm_restart") {
		return {
			text:
				"<b>♻️ 重启 pi-tg</b>\n\n" +
				(ctx.busy() ? "⚠️ 当前任务会被中断，但模型和思考等级会保留。\n\n" : "模型、思考等级和当前会话都会保留。\n\n") +
				"确定立即重启？",
			markup: keyboard([
				[
					{ text: "♻️ 确认重启", data: cb("do_restart") },
					{ text: "取消", data: cb("view", "status") },
				],
			]),
		};
	}

	// status (default)
	const usage = session.getContextUsage();
	const spec = ctx.modelSpec();
	const totalTokens = ((session.getSessionStats() as { tokens?: { total?: number } }).tokens?.total ?? 0).toLocaleString("en-US");
	const lines = [
		"<b>📊 pi-tg 状态</b>",
		"",
		`运行时长：${fmtDuration(ctx.uptimeMs())}`,
		`轮询：<code>${esc(ctx.pollerState())}</code>`,
		`状态：${ctx.busy() ? "⏳ 正在处理" : "✅ 空闲"}${ctx.queueDepth() > 0 ? `（排队 ${ctx.queueDepth()}）` : ""}`,
		"",
		`模型：<code>${esc(`${session.model.provider}/${session.model.id}`)}</code>${spec ? "" : " <i>(来自 settings.json)</i>"}`,
		`思考：<code>${esc(session.supportsThinking() ? session.thinkingLevel : "不支持")}</code>`,
		`上下文：${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")}（${usage.percent.toFixed(2)}%）`,
		`累计 token：${totalTokens}`,
		`会话：<code>${esc(session.sessionId.slice(0, 8))}</code> · 第 ${gen} 代`,
	];
	return {
		text: lines.join("\n"),
		markup: keyboard([
			nav(ctx, gen),
			[{ text: "🆕 新会话", data: cb("view", "confirm_new") }, { text: "⏹ 中断", data: cb("stop") }],
			[{ text: "♻️ 一键重启 pi-tg", data: cb("view", "confirm_restart") }],
		]),
	};
}
