/** Single-operator Telegram daemon. Polling never waits for model work. */
import { loadConfig } from "./config.ts";
import { createLogger, errFields, setLevel } from "./log.ts";
import { TgError } from "./errors.ts";
import { TelegramApi } from "./telegram/api.ts";
import { Poller } from "./telegram/poller.ts";
import { COMMANDS } from "./telegram/commands.ts";
import { LiveMessage } from "./telegram/live.ts";
import { AgentHost } from "./agent/host.ts";
import { Dispatcher } from "./agent/dispatcher.ts";
import { createEventRouter } from "./agent/events.ts";
import { DeliveryStore, retryPendingDelivery } from "./telegram/delivery.ts";
import { MediaGroups } from "./telegram/media-groups.ts";
import { AuditLog } from "./agent/audit.ts";
import { State } from "./state.ts";
import { Files } from "./telegram/files.ts";
import { prepareStickerFile } from "./telegram/sticker.ts";
import { createSendFileTool } from "./agent/outbox.ts";
import { createAskTool } from "./agent/ask.ts";
import { TypingIndicator } from "./telegram/typing.ts";
import { TelegramUI } from "./ui/telegram-ui.ts";
import { decodeCallback, makeBootId } from "./telegram/keyboard.ts";
import { renderPanel, type PanelContext } from "./ui/panel.ts";
import type { TgUpdate } from "./telegram/types.ts";

const EXIT_CONFIG_FAULT = 78;
const configPath = process.argv[2] ?? process.env.PI_TG_CONFIG ?? "/etc/pi-tg/config.json";
const config = (() => {
	try { return loadConfig(configPath); }
	catch { process.stderr.write("Invalid pi-tg configuration. Check configuration and permissions.\n"); process.exit(EXIT_CONFIG_FAULT); }
})();
setLevel(config.logLevel);
const log = createLogger("pi-tg");
const api = new TelegramApi(config.botToken, log.child("api"));
const state = new State(config.statePath, log.child("state"));
const deliveries = new DeliveryStore(`${config.statePath}.deliveries.json`);
const audit = new AuditLog(config.auditPath, log.child("audit"));
const typing = new TypingIndicator(api, log.child("typing"));
const files = new Files(api, log.child("files"), config.files);
const bootedAt = Date.now();
const bootId = makeBootId(bootedAt);
let dispatcher: Dispatcher;
let fatal: TgError | null = null;
let shuttingDown = false;
let staleSkipped = 0;

/** Every detached UI operation observes its rejection; it cannot end a model run. */
function background(work: Promise<unknown>, msg: string): void {
	void work.catch((err) => log.warn({ msg, ...errFields(err) }));
}
function send(chatId: number, text: string, replyTo?: number): Promise<unknown> {
	return api.sendMessage({ chat_id: chatId, text, ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }) });
}
const telegramUI: TelegramUI = new TelegramUI({ api, log: log.child("ui"), bootId,
	currentChatId: () => dispatcher?.currentChatId ?? null, generation: (): number => host.generation });
const route = createEventRouter({
	log: log.child("events"), currentGeneration: () => host.generation,
	tools: { start: (info) => audit.start({ generation: host.generation, ...info }), end: (info) => audit.end(info) },
	sink: {
		onStart: () => dispatcher?.markStarted(),
		onAnswer: (text) => dispatcher?.current?.setAnswer(text),
		onThinking: (text) => dispatcher?.current?.setThinking(text),
		onActivity: (text) => dispatcher?.current?.setActivity(text),
		onSettled: (text) => dispatcher?.markSettled(text),
	},
});
const host: AgentHost = new AgentHost({
	config, log: log.child("agent"),
	onEvent: (generation, event) => { if (generation === host.generation) dispatcher?.noteActivity(); route(generation, event); },
	onAbortRequested: () => background(dispatcher?.abort() ?? Promise.resolve(), "abort failed"),
	onShutdownRequested: () => background(shutdown("extension"), "shutdown failed"),
	loadPreferences: () => state.agentPreferences, savePreferences: (patch) => state.setAgentPreferences(patch),
	customTools: [createSendFileTool({ currentChatId: () => dispatcher?.currentChatId ?? null, files, log: log.child("outbox") }),
		createAskTool({ ui: telegramUI, log: log.child("ask") })],
	uiContext: telegramUI,
});
const poller = new Poller(api, log.child("poll"), {
	allowedUserId: config.allowedUserId, commands: COMMANDS, onUpdate: handleUpdate, onFatal: (err) => { fatal = err; },
});
const panelCtx: PanelContext = { host, bootId, pollerState: () => poller.state, busy: () => dispatcher.busy,
	queueDepth: () => dispatcher.queueDepth, uptimeMs: () => Date.now() - bootedAt,
	modelSpec: () => state.agentPreferences.model ?? config.model };

async function showPanel(chatId: number, view: string, messageId?: number): Promise<void> {
	const panel = await renderPanel(panelCtx, view);
	const common = { chat_id: chatId, text: panel.text, parse_mode: "HTML" as const,
		link_preview_options: { is_disabled: true }, reply_markup: panel.markup };
	if (messageId !== undefined) {
		try { await api.editMessageText({ ...common, message_id: messageId }); }
		catch (err) { if (!/not modified/i.test(String(err))) throw err; }
	} else await api.sendMessage(common);
}

async function handleCallback(update: TgUpdate): Promise<void> {
	const q = update.callback_query;
	if (!q) return;
	const chatId = q.message?.chat.id, messageId = q.message?.message_id;
	const decoded = decodeCallback(q.data);
	const answer = (text?: string) => api.answerCallbackQuery(q.id, text).catch(() => undefined);
	if (!decoded || chatId === undefined || messageId === undefined) { await answer("按钮已失效"); return; }
	if (decoded.boot !== bootId || decoded.gen !== host.generation) { await answer("这个面板是旧会话的，发 /start 重开"); return; }
	if (decoded.action === "cf") { await answer(telegramUI.resolve(decoded.arg).ok ? "已记录" : "这个提问已过期"); return; }
	switch (decoded.action) {
		case "view": await answer(); await showPanel(chatId, decoded.arg || "status", messageId); return;
		case "mpage": await answer(); await showPanel(chatId, `model:${decoded.arg}`, messageId); return;
		case "stop": await answer("已请求中断"); await dispatcher.abort(); await showPanel(chatId, "status", messageId); return;
		case "do_new": await answer("正在开新会话…"); await dispatcher.reset(); await showPanel(chatId, "status", messageId); return;
		case "do_restart":
			await answer("正在重启 pi-tg…");
			await send(chatId, "♻️ 正在重启服务，当前任务可能被中断。会话与模型选择会保留。").catch(() => undefined);
			await shutdown("panel restart"); return;
		case "model": {
			if (dispatcher.busy) { await answer("正在跑任务，稍后再切"); return; }
			// Lock admissions BEFORE acknowledging the callback (which itself awaits I/O).
			const switching = dispatcher.exclusive(async () => {
				await answer("正在切换…");
				if (!await host.setModelSpec(decoded.arg)) await send(chatId, "模型切换失败。");
			});
			await switching; await showPanel(chatId, "model", messageId); return;
		}
		case "think":
			if (dispatcher.busy) { await answer("正在跑任务，稍后再切"); return; }
			await answer(host.setThinking(decoded.arg) ? `思考等级：${decoded.arg}` : "设置失败");
			await showPanel(chatId, "think", messageId); return;
		default: await answer("未知操作");
	}
}

function enqueueFiles(chatId: number, replyTo: number, caption: string, paths: string[], rejected: string[]): void {
	if (shuttingDown) return;
	if (rejected.length) background(send(chatId, `⚠️ 有附件没收下：\n${rejected.join("\n")}`, replyTo), "attachment notice failed");
	if (!paths.length) return;
	const list = paths.map((p) => `- ${p}`).join("\n");
	const text = caption.trim() ? `${caption.trim()}\n\n（我通过 Telegram 发来的文件已保存到本机：\n${list}\n）`
		: `我通过 Telegram 发来了文件，已保存到本机：\n${list}\n\n请查看这些文件并告诉我它们是什么。`;
	dispatcher.enqueue({ text, chatId, replyTo });
}
const mediaGroups = new MediaGroups((group) => {
	const first = group.items[0];
	if (!first) return;
	enqueueFiles(group.chatId, first.messageId, group.items.map((i) => i.caption).filter(Boolean).join("\n"),
		group.items.flatMap((i) => i.paths), group.items.flatMap((i) => i.rejected));
});
async function handleAttachment(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
	const caption = (msg.caption ?? "").trim();
	const complete = msg.media_group_id ? mediaGroups.add(msg.media_group_id, msg.chat.id, msg.message_id, caption) : null;
	let result: { paths: string[]; rejected: string[] };
	try { result = await files.receive(msg); }
	catch (err) { log.warn({ msg: "attachment download failed", ...errFields(err) }); result = { paths: [], rejected: ["附件下载失败，请重发。"] }; }
	if (complete) complete(result);
	else enqueueFiles(msg.chat.id, msg.message_id, caption, result.paths, result.rejected);
}
async function handleSticker(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
	const sticker = msg.sticker;
	if (!sticker) return;
	const { paths, rejected } = await files.receive(msg);
	if (rejected.length) background(send(msg.chat.id, `⚠️ 有附件没收下：\n${rejected.join("\n")}`, msg.message_id), "sticker notice failed");
	if (!paths.length || shuttingDown) return;
	const lines: string[] = [];
	for (const path of paths) {
		const prepared = await prepareStickerFile(path, log);
		lines.push(...prepared.lottieText.map((t) => `动画内容文字：${t}`), ...prepared.paths.map((p) => `- ${p}`));
	}
	const kind = sticker.is_video ? "视频 sticker" : sticker.is_animated ? "动画 sticker" : "静态 sticker";
	const meta = [`${kind}（${sticker.width}×${sticker.height}）`, sticker.set_name, sticker.emoji].filter(Boolean).join("；");
	dispatcher.enqueue({ chatId: msg.chat.id, replyTo: msg.message_id,
		text: `${msg.caption || "请识别这个 sticker 表达了什么，然后简短地告诉我。"}\n\n${meta}\n已保存到本机：\n${lines.join("\n")}` });
}

function handleUpdate(update: TgUpdate): void {
	if (shuttingDown) return;
	dispatcher.noteActivity();
	if (state.alreadySeen(update.update_id)) return;
	state.markSeen(update.update_id);
	if (update.callback_query) { background(handleCallback(update), "callback failed"); return; }
	const msg = update.message;
	if (!msg) return;
	const ageSeconds = Math.floor(Date.now() / 1000) - msg.date;
	if (ageSeconds > config.coldStart.staleSeconds && msg.date * 1000 < bootedAt) {
		if (++staleSkipped === 1) background(send(msg.chat.id, "⚠️ 已跳过离线期间积压的旧消息，需要的话请重发。"), "stale notice failed");
		return;
	}
	if (msg.voice) { background(send(msg.chat.id, "暂不支持语音消息，请发文字。", msg.message_id), "voice notice failed"); return; }
	if (msg.sticker) { background(handleSticker(msg), "sticker failed"); return; }
	if (msg.photo || msg.document) { background(handleAttachment(msg), "attachment failed"); return; }
	const text = (msg.text ?? msg.caption ?? "").trim();
	if (!text) { background(send(msg.chat.id, "这条消息里没有文字也没有附件。"), "empty notice failed"); return; }
	if (["/start", "/help", "/panel", "/status"].includes(text)) { background(showPanel(msg.chat.id, "status"), "status panel failed"); return; }
	if (["/tokens", "/usage"].includes(text)) { background(showPanel(msg.chat.id, "tokens"), "tokens panel failed"); return; }
	if (text === "/stop") {
		background(dispatcher.abort(), "abort failed"); background(send(msg.chat.id, "⏹ 已请求中断。"), "stop notice failed"); return;
	}
	if (text === "/new") {
		background(dispatcher.reset().then(() => send(msg.chat.id, "🆕 已开新会话。"), () => send(msg.chat.id, "⚠️ 新会话创建失败，请检查服务状态。")), "new failed"); return;
	}
	if (text === "/retry") {
		if (dispatcher.busy) { background(send(msg.chat.id, "请等当前任务结束后再重发。"), "retry busy notice failed"); return; }
		background(dispatcher.exclusive(async () => {
			if (!deliveries.pending(msg.chat.id).length) { await send(msg.chat.id, "没有待重发的回答。"); return; }
			try { await retryPendingDelivery(api, deliveries, msg.chat.id); state.endTurn(); await send(msg.chat.id, "✅ 待重发回答已送出。"); }
			catch { await send(msg.chat.id, "⚠️ 仍未完整送达，未确认分段继续保留，可稍后 /retry。网络超时可能导致重复分段。"); }
		}), "retry failed"); return;
	}
	dispatcher.enqueue({ text, chatId: msg.chat.id, replyTo: msg.message_id });
}

const keepAlive = setInterval(() => {}, 1 << 30);
async function shutdown(reason: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info({ msg: "shutting down", reason });
	clearInterval(keepAlive);
	mediaGroups.close();
	poller.stop();
	// Final outbox/interrupted state survives a forced supervisor timeout.
	const deadline = setTimeout(() => process.exit(1), 22_000);
	try { await dispatcher?.shutdown(); await host.stop(); }
	finally { clearTimeout(deadline); process.exit(fatal ? EXIT_CONFIG_FAULT : 0); }
}
async function main(): Promise<void> {
	state.load(); deliveries.load(); audit.init(); files.sweep();
	await host.start();
	dispatcher = new Dispatcher({
		host, log, idleTimeoutMs: config.turn.idleTimeoutMs,
		createLive: (item) => new LiveMessage(api, log.child("live"), { ...config.render, chatId: item.chatId, replyTo: item.replyTo, deliveryStore: deliveries }),
		onBegin: (item, live) => {
			typing.start(item.chatId);
			state.beginTurn({ chatId: item.chatId, messageId: live.stats.messageId ?? item.replyTo, startedAt: Date.now() });
		},
		onEnd: (delivered) => { typing.stop(); if (delivered) state.endTurn(); },
	});
	await poller.preflight();
	log.info({ msg: "ready" });
	const orphan = state.interrupted;
	if (orphan) {
		await send(config.allowedUserId, "⚠️ 上一轮在服务重启时被打断，可能已执行部分操作；不会自动重跑任务。").catch(() => undefined);
		state.clearInterrupted();
	}
	if (deliveries.pending(config.allowedUserId).length) {
		await send(config.allowedUserId, "⚠️ 有回答尚未确认完整送达。发送 /retry 重发；不会重新执行模型或工具。超时可能造成重复分段。").catch(() => undefined);
	}
	process.on("SIGTERM", () => background(shutdown("SIGTERM"), "shutdown failed"));
	process.on("SIGINT", () => background(shutdown("SIGINT"), "shutdown failed"));
	process.on("uncaughtException", (err) => { log.error({ msg: "uncaught exception", ...errFields(err) }); process.exit(1); });
	process.on("unhandledRejection", (err) => {
		// Do not mark a healthy run settled for an unrelated background failure.
		log.error({ msg: "unhandled rejection", ...errFields(err) });
	});
	await poller.run();
	if (fatal) await shutdown("fatal polling error");
}
main().catch((err) => { log.error({ msg: "startup failed", ...errFields(err) }); process.exit(err instanceof TgError && err.kind === "fatal" ? EXIT_CONFIG_FAULT : 1); });
