/**
 * pi-tg — headless Telegram daemon embedding the pi coding agent SDK.
 *
 * M1: receive a message from the allowlisted user, run one agent turn, stream
 * the answer back into a single live-edited Telegram message. Persistence,
 * markdown rendering, the operator panel and files land in later milestones.
 *
 * Exit codes: 0 clean, 1 crash (systemd restarts), 78 terminal config fault
 * (systemd must NOT restart — the token is revoked or the config is wrong).
 */

import { loadConfig, type Config } from "./config.ts";
import { createLogger, errFields, setLevel } from "./log.ts";
import { TgError } from "./errors.ts";
import { TelegramApi } from "./telegram/api.ts";
import { Poller } from "./telegram/poller.ts";
import { LiveMessage } from "./telegram/live.ts";
import { AgentHost } from "./agent/host.ts";
import { createEventRouter } from "./agent/events.ts";
import { IdleWatchdog } from "./agent/idle-watchdog.ts";
import { steerIfStreaming } from "./agent/incoming.ts";
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

let config: Config;
try {
	config = loadConfig(configPath);
} catch (err) {
	process.stderr.write(`${String(err)}\n`);
	process.exit(EXIT_CONFIG_FAULT);
}

setLevel(config.logLevel);
const log = createLogger("pi-tg");

const api = new TelegramApi(config.botToken, log.child("api"));
const state = new State(config.statePath, log.child("state"));
const audit = new AuditLog(config.auditPath, log.child("audit"));
const typing = new TypingIndicator(api, log.child("typing"));
const files = new Files(api, log.child("files"), config.files);

/** Process start time — anything older than this predates us being alive. */
const bootedAt = Date.now();
const bootId = makeBootId(bootedAt);

const telegramUI: TelegramUI = new TelegramUI({
	api,
	log: log.child("ui"),
	bootId,
	currentChatId: (): number | null => dispatcher?.currentChatId ?? null,
	generation: (): number => host.generation,
});

/**
 * One active Pi run at a time. New Telegram messages steer that active run at
 * its next model boundary; this local FIFO remains only as a race fallback for
 * messages that arrive while a run is settling or another prompt is starting.
 */
class Dispatcher {
	private readonly queue: Array<{ text: string; chatId: number; replyTo: number; placeholderId?: number }> = [];
	private running = false;
	private live: LiveMessage | null = null;
	private settle: (() => void) | null = null;
	private readonly idleWatchdog = new IdleWatchdog(config.turn.idleTimeoutMs, () => {
		if (!this.running) return;
		log.warn({ msg: "turn inactive, aborting", idleTimeoutMs: config.turn.idleTimeoutMs });
		void this.host.session.abort();
	});
	private activeChatId: number | null = null;

	private readonly host: AgentHost;

	constructor(agentHost: AgentHost) {
		this.host = agentHost;
	}

	get busy(): boolean {
		return this.running;
	}

	get queueDepth(): number {
		return this.queue.length;
	}

	/** Destination for telegram_send_file during the running turn. */
	get currentChatId(): number | null {
		return this.activeChatId;
	}

	get current(): LiveMessage | null {
		return this.live;
	}

	/** Any accepted Telegram request or agent event proves this turn is alive. */
	noteActivity(): void {
		if (this.running) this.idleWatchdog.touch();
	}

	enqueue(item: { text: string; chatId: number; replyTo: number }): void {
		this.noteActivity();
		if (this.running) {
			void this.deliverMidRun(item);
			return;
		}
		this.queue.push({ ...item });
		void this.pump();
	}

	private async deliverMidRun(item: { text: string; chatId: number; replyTo: number }): Promise<void> {
		try {
			const session = this.host.session;
			if (await steerIfStreaming(session, item.text)) {
				log.info({ msg: "steered active turn", promptLen: item.text.length, pending: session.pendingMessageCount });
				return;
			}
		} catch (err) {
			// The run can settle between the isStreaming check and steer(). Falling
			// back to the local FIFO is lossless; only unexpected failures are logged.
			log.warn({ msg: "mid-run steering raced, using fallback queue", ...errFields(err) });
		}

		const queued: { text: string; chatId: number; replyTo: number; placeholderId?: number } = { ...item };
		this.queue.push(queued);
		void api
			.sendMessage({
				chat_id: item.chatId,
				text: `⏳ 当前一轮刚结束，已作为下一条任务排队`,
				reply_to_message_id: item.replyTo,
			})
			.then((msg) => {
				queued.placeholderId = msg.message_id;
			})
			.catch(() => undefined);
		log.info({ msg: "queued after steering race", queueDepth: this.queue.length });
		if (!this.running) void this.pump();
	}

	/** Called by the event router when the session reports agent_settled. */
	markSettled(): void {
		this.settle?.();
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		const item = this.queue.shift();
		if (!item) return;
		this.running = true;

		const live = new LiveMessage(api, log.child("live"), {
			chatId: item.chatId,
			replyTo: item.replyTo,
			editThrottleMs: config.render.editThrottleMs,
			maxChars: config.render.maxChars,
			maxEditsPerTurn: config.render.maxEditsPerTurn,
			notifyAfterMs: config.render.notifyAfterMs,
			...(item.placeholderId !== undefined ? { existingMessageId: item.placeholderId } : {}),
		});
		live.setPrompt(item.text);
		this.live = live;
		this.activeChatId = item.chatId;

		const settled = new Promise<void>((resolve) => {
			this.settle = () => {
				this.settle = null;
				resolve();
			};
		});

		const startedAt = Date.now();
		log.info({ msg: "turn start", chatId: item.chatId, replyTo: item.replyTo, promptLen: item.text.length, queued: this.queue.length });

		typing.start(item.chatId);

		try {
			await live.begin("⏳ …");
			// Recorded only after the placeholder exists, so a restart can point at
			// a real message rather than at a turn that never became visible.
			state.beginTurn({ chatId: item.chatId, messageId: live.stats.messageId ?? item.replyTo, startedAt });
			this.idleWatchdog.touch();

			await this.host.session.prompt(item.text);
			await settled;
		} catch (err) {
			// prompt() throws on: run already active, during compaction, no model
			// selected, failed provider auth. None of those should kill the daemon.
			// Do not echo the raw error to Telegram: providers and extensions may put
			// request bodies, URLs or credentials in it.
			log.error({ msg: "turn failed", ...errFields(err) });
			await live.finish("⚠️ 这一轮失败了。详细错误已隐藏，请检查服务状态和本机日志中的错误类型。").catch(() => {});
		} finally {
			typing.stop();
			this.idleWatchdog.stop();
			this.activeChatId = null;
			state.endTurn();
			log.info({ msg: "turn end", durationMs: Date.now() - startedAt, edits: live.stats.edits, messageId: live.stats.messageId });
			this.settle = null;
			this.live = null;
			this.running = false;
		}

		if (this.queue.length > 0) void this.pump();
	}
}

let dispatcher: Dispatcher;

const route = createEventRouter({
	log: log.child("events"),
	currentGeneration: () => host.generation,
	tools: {
		start: (info) => audit.start({ generation: host.generation, ...info }),
		end: (info) => audit.end(info),
	},
	sink: {
		onStart: () => {},
		onAnswer: (text) => dispatcher.current?.setAnswer(text),
		onThinking: (text) => dispatcher.current?.setThinking(text),
		onActivity: (line) => dispatcher.current?.setActivity(line),
		onSettled: (finalText) => {
			const live = dispatcher.current;
			dispatcher.markSettled();
			void live?.finish(finalText);
		},
	},
});

const host = new AgentHost({
	config,
	log: log.child("agent"),
	onEvent: (generation, event) => {
		dispatcher?.noteActivity();
		route(generation, event);
	},
	onAbortRequested: () => void host.session.abort(),
	onShutdownRequested: () => void shutdown("extension"),
	loadPreferences: () => state.agentPreferences,
	savePreferences: (patch) => state.setAgentPreferences(patch),
	customTools: [
		createSendFileTool({ currentChatId: () => dispatcher?.currentChatId ?? null, files, log: log.child("outbox") }),
		createAskTool({ ui: telegramUI, log: log.child("ask") }),
	],
	uiContext: telegramUI,
});

let fatal: TgError | null = null;

/**
 * The slash menu. Kept next to the router below that implements these, so the
 * two cannot drift — the menu previously lived in the poller and went stale.
 * Every entry here must have a branch in handleUpdate().
 */
const COMMANDS = [
	{ command: "start", description: "操作面板" },
	{ command: "tokens", description: "Token 用量统计" },
	{ command: "status", description: "当前状态" },
	{ command: "new", description: "开一个新会话（清空上下文）" },
	{ command: "stop", description: "中断当前任务" },
	{ command: "help", description: "帮助" },
];

const poller = new Poller(api, log.child("poll"), {
	allowedUserId: config.allowedUserId,
	commands: COMMANDS,
	onUpdate: (update: TgUpdate) => handleUpdate(update),
	onFatal: (err) => {
		fatal = err;
	},
});

const panelCtx: PanelContext = {
	host: null as unknown as AgentHost, // filled in main() once the host exists
	bootId,
	pollerState: () => poller.state,
	busy: () => dispatcher.busy,
	queueDepth: () => dispatcher.queueDepth,
	uptimeMs: () => Date.now() - bootedAt,
	modelSpec: () => state.agentPreferences.model ?? config.model,
};

async function showPanel(chatId: number, view: string, editMessageId?: number): Promise<void> {
	const panel = await renderPanel(panelCtx, view);
	if (editMessageId !== undefined) {
		await api
			.editMessageText({
				chat_id: chatId,
				message_id: editMessageId,
				text: panel.text,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				reply_markup: panel.markup,
			})
			.catch((err: unknown) => {
				if (!/not modified/i.test(String(err))) log.warn({ msg: "panel edit failed", ...errFields(err) });
			});
		return;
	}
	await api.sendMessage({
		chat_id: chatId,
		text: panel.text,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
		reply_markup: panel.markup,
	});
}

async function handleCallback(update: TgUpdate): Promise<void> {
	const q = update.callback_query;
	if (!q) return;
	const chatId = q.message?.chat.id;
	const messageId = q.message?.message_id;
	const decoded = decodeCallback(q.data);

	const answer = (text?: string): Promise<unknown> => api.answerCallbackQuery(q.id, text).catch(() => undefined);

	if (!decoded || chatId === undefined || messageId === undefined) {
		await answer("按钮已失效");
		return;
	}
	// A tap from a panel minted before a restart or a /new refers to a session
	// that no longer exists. Say so rather than acting on the current one.
	if (decoded.boot !== bootId || decoded.gen !== host.generation) {
		await answer("这个面板是旧会话的，发 /start 重开");
		return;
	}

	// Extension dialogs (e.g. the security extension's confirm) resolve here.
	if (decoded.action === "cf") {
		const resolved = telegramUI.resolve(decoded.arg);
		await answer(resolved.ok ? "已记录" : "这个提问已过期");
		return;
	}

	log.info({ msg: "callback", action: decoded.action, arg: decoded.arg });

	switch (decoded.action) {
		case "view":
			await answer();
			await showPanel(chatId, decoded.arg || "status", messageId);
			return;
		case "stop":
			await answer("已请求中断");
			await host.session.abort().catch(() => undefined);
			await showPanel(chatId, "status", messageId);
			return;
		case "do_new":
			await answer("正在开新会话…");
			await host.reset();
			await showPanel(chatId, "status", messageId);
			return;
		case "do_restart":
			// Answer the callback and visibly acknowledge the request before exiting.
			// systemd Restart=always starts the process again; no shell/systemctl call
			// (and therefore no extra privilege) is needed inside the bot.
			await answer("正在重启 pi-tg…");
			await api
				.editMessageText({
					chat_id: chatId,
					message_id: messageId,
					text: "♻️ <b>pi-tg 正在重启…</b>\n\n几秒后发送 /start 即可打开新面板。",
					parse_mode: "HTML",
				})
				.catch(() => undefined);
			void shutdown("panel restart");
			return;
		case "mpage": {
			await answer();
			await showPanel(chatId, `model:${decoded.arg}`, messageId);
			return;
		}
		case "model": {
			if (dispatcher.busy) {
				await answer("正在跑任务，稍后再切");
				return;
			}
			const ok = await host.setModelSpec(decoded.arg);
			await answer(ok ? `已切到 ${decoded.arg}` : "切换失败");
			await showPanel(chatId, "model", messageId);
			return;
		}
		case "think": {
			if (dispatcher.busy) {
				await answer("正在跑任务，稍后再切");
				return;
			}
			const ok = host.setThinking(decoded.arg);
			await answer(ok ? `思考等级：${decoded.arg}` : "设置失败");
			await showPanel(chatId, "think", messageId);
			return;
		}
		default:
			await answer("未知操作");
	}
}

/**
 * Download attachments, then turn them into a prompt that names the saved
 * paths. The caption is the operator's actual instruction; without one we ask
 * the model to look at the file rather than guessing at intent.
 */
/**
 * Download attachments, then turn them into a prompt that names the saved
 * paths. The caption is the operator's actual instruction; without one we ask
 * the model to look at the file rather than guessing at intent.
 */
async function handleAttachment(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
	const { paths, rejected } = await files.receive(msg);
	if (rejected.length > 0) {
		await api
			.sendMessage({ chat_id: msg.chat.id, text: `⚠️ 有附件没收下：\n${rejected.join("\n")}`, reply_to_message_id: msg.message_id })
			.catch(() => undefined);
	}
	if (paths.length === 0) return;

	const caption = (msg.caption ?? "").trim();
	const list = paths.map((p) => `- ${p}`).join("\n");
	const text = caption
		? `${caption}\n\n（我通过 Telegram 发来的文件已保存到本机：\n${list}\n）`
		: `我通过 Telegram 发来了文件，已保存到本机：\n${list}\n\n请查看这些文件并告诉我它们是什么。`;

	log.info({ msg: "attachment saved", count: paths.length, hasCaption: caption.length > 0 });
	dispatcher.enqueue({ text, chatId: msg.chat.id, replyTo: msg.message_id });
}

/**
 * Sticker messages carry no text, so v1 used to answer "no text, nothing to
 * do". Now we download the file, preprocess it (tgs → extract Lottie text
 * layers, webm → first frame) and hand the model a path it can inspect, plus
 * whatever metadata Telegram gave us (emoji, pack name).
 */
async function handleSticker(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
	const sticker = msg.sticker;
	if (!sticker) return;

	const { paths, rejected } = await files.receive(msg);
	if (rejected.length > 0) {
		await api
			.sendMessage({ chat_id: msg.chat.id, text: `⚠️ 有附件没收下：\n${rejected.join("\n")}`, reply_to_message_id: msg.message_id })
			.catch(() => undefined);
	}
	if (paths.length === 0) return;

	// Preprocess each downloaded file, then fold the useful bits into the prompt.
	const prepared: Array<{ paths: string[]; lottieText: string[] }> = [];
	for (const p of paths) prepared.push(await prepareStickerFile(p, log));

	const kind = sticker.is_video ? "视频 sticker" : sticker.is_animated ? "动画 sticker" : "静态 sticker";
	const meta = [`${kind}（${sticker.width}×${sticker.height}）`];
	if (sticker.set_name) meta.push(`贴纸包：${sticker.set_name}`);
	if (sticker.emoji) meta.push(`关联 emoji：${sticker.emoji}`);

	const lines: string[] = [];
	for (const item of prepared) {
		for (const text of item.lottieText) lines.push(`动画内容文字：${text}`);
		for (const p of item.paths) lines.push(`- ${p}`);
	}

	const caption = (msg.caption ?? "").trim();
	const text = caption
		? `${caption}\n\n（我通过 Telegram 发来一个 ${kind}：${meta.join("；")}\n已保存到本机：\n${lines.join("\n")}\n）`
		: `我通过 Telegram 发来一个 ${kind}：${meta.join("；")}\n已保存到本机：\n${lines.join("\n")}\n\n请识别这个 sticker 表达了什么，然后简短地告诉我。`;

	log.info({ msg: "sticker saved", count: paths.length, kind, hasCaption: caption.length > 0 });
	dispatcher.enqueue({ text, chatId: msg.chat.id, replyTo: msg.message_id });
}

function handleUpdate(update: TgUpdate): void {
	// Every incoming request renews a running turn's inactivity window, including
	// control commands, callbacks and mid-turn prompts that will be queued.
	dispatcher?.noteActivity();

	// A redelivered update means we processed it but the confirming getUpdates
	// never landed. Answering twice is worse than answering once.
	if (state.alreadySeen(update.update_id)) {
		log.info({ msg: "duplicate update ignored", updateId: update.update_id });
		return;
	}
	state.markSeen(update.update_id);

	if (update.callback_query) {
		void handleCallback(update).catch((err: unknown) => log.warn({ msg: "callback handling failed", ...errFields(err) }));
		return;
	}

	const msg = update.message;
	if (!msg) {
		log.info({ msg: "update carries no message, ignoring", updateId: update.update_id });
		return;
	}

	log.info({
		msg: "message received",
		updateId: update.update_id,
		messageId: msg.message_id,
		chatId: msg.chat.id,
		// Content is never logged; length is enough to tell "empty" from "arrived".
		textLen: (msg.text ?? msg.caption ?? "").length,
		kind: msg.voice ? "voice" : msg.sticker ? "sticker" : msg.photo ? "photo" : msg.document ? "document" : "text",
	});

	// Cold start: a backlog that queued while we were down must not execute in a
	// burst. `date` is server-side seconds, so this is immune to clock skew on
	// our side being large in the other direction.
	const ageSeconds = Math.floor(Date.now() / 1000) - msg.date;
	if (ageSeconds > config.coldStart.staleSeconds && msg.date * 1000 < bootedAt) {
		staleSkipped++;
		log.warn({ msg: "skipping stale message from before boot", messageId: msg.message_id, ageSeconds });
		if (staleSkipped === 1) {
			void api.sendMessage({
				chat_id: msg.chat.id,
				text: `⚠️ 我离线了一段时间，跳过了离线期间收到的旧消息（最早一条 ${Math.round(ageSeconds / 60)} 分钟前）。需要的话请重发。`,
			});
		}
		return;
	}

	if (msg.voice) {
		void api.sendMessage({ chat_id: msg.chat.id, text: "v1 还不支持语音消息，请发文字。", reply_to_message_id: msg.message_id });
		return;
	}

	if (msg.sticker) {
		void handleSticker(msg).catch((err: unknown) => log.warn({ msg: "sticker handling failed", ...errFields(err) }));
		return;
	}

	// Attachments are downloaded first so their paths can be named in the prompt.
	// The model is text-only, so a photo becomes a path the tools can read, not
	// image content the provider would reject.
	if (msg.photo || msg.document) {
		void handleAttachment(msg).catch((err: unknown) => log.warn({ msg: "attachment handling failed", ...errFields(err) }));
		return;
	}

	const text = (msg.text ?? msg.caption ?? "").trim();
	if (!text) {
		log.info({ msg: "no text content, nothing to prompt with", messageId: msg.message_id });
		void api.sendMessage({ chat_id: msg.chat.id, text: "这条消息里没有文字也没有附件，没什么可处理的。" });
		return;
	}

	if (text === "/start" || text === "/help" || text === "/panel") {
		void showPanel(msg.chat.id, "status").catch((err: unknown) => log.warn({ msg: "panel send failed", ...errFields(err) }));
		return;
	}
	if (text === "/stop") {
		void host.session.abort();
		void api.sendMessage({ chat_id: msg.chat.id, text: "⏹ 已请求中断。" });
		return;
	}
	if (text === "/tokens" || text === "/usage") {
		void showPanel(msg.chat.id, "tokens").catch((err: unknown) => log.warn({ msg: "tokens panel failed", ...errFields(err) }));
		return;
	}
	if (text === "/status") {
		const s = host.session;
		const usage = s.getContextUsage();
		void api.sendMessage({
			chat_id: msg.chat.id,
			text: [
				`轮询: ${poller.state}`,
				`模型: ${s.model.provider}/${s.model.id}`,
				`思考: ${s.supportsThinking() ? s.thinkingLevel : "不支持"}`,
				`上下文: ${usage.tokens} / ${usage.contextWindow} (${usage.percent.toFixed(2)}%)`,
				`忙碌: ${dispatcher.busy ? "是" : "否"}`,
			].join("\n"),
		});
		return;
	}
	if (text === "/new") {
		void host.reset().then(
			() => api.sendMessage({ chat_id: msg.chat.id, text: "🆕 已开新会话。" }),
			(err: unknown) => {
				log.warn({ msg: "new session failed", ...errFields(err) });
				return api.sendMessage({ chat_id: msg.chat.id, text: "新建会话失败。详细错误已隐藏，请检查本机日志中的错误类型。" });
			},
		);
		return;
	}

	dispatcher.enqueue({ text, chatId: msg.chat.id, replyTo: msg.message_id });
}

/**
 * A ref'd handle held for the process lifetime.
 *
 * Without it, any moment where no socket or timer happens to be pending lets
 * Node drain the event loop and exit 0 — which systemd reads as a successful
 * run and does not restart. A daemon must only ever exit because we said so.
 */
const keepAlive = setInterval(() => {}, 1 << 30);

let staleSkipped = 0;
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info({ msg: "shutting down", reason });

	clearInterval(keepAlive);
	poller.stop();
	await dispatcher.current?.sealWith("⏹ 服务重启中，本轮已中断。").catch(() => {});
	await host.stop();
	log.info({ msg: "shutdown complete" });
	process.exit(fatal ? EXIT_CONFIG_FAULT : 0);
}

async function main(): Promise<void> {
	log.info({ msg: "starting" });

	state.load();
	audit.init();
	files.sweep();

	await host.start();
	dispatcher = new Dispatcher(host);
	panelCtx.host = host;

	await poller.preflight();
	log.info({ msg: "ready" });

	// A turn that was in flight when we died leaves a dead "⏳" in the chat. Say
	// so rather than re-running it: the prompt may have already had side effects,
	// and re-executing an unknown root command unattended is not acceptable.
	const orphan = state.interrupted;
	if (orphan) {
		state.clearInterrupted();
		log.warn({ msg: "reporting interrupted turn from previous run", ...orphan });
		await api
			.sendMessage({
				chat_id: orphan.chatId,
				text: "⚠️ 上一轮在服务重启时被打断了（可能已经执行了部分操作）。需要的话请重发。",
				reply_to_message_id: orphan.messageId,
			})
			.catch((err: unknown) => log.warn({ msg: "interrupted-turn notice failed", ...errFields(err) }));
	}

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("uncaughtException", (err) => {
		log.error({ msg: "uncaught exception", ...errFields(err) });
		process.exit(1);
	});
	process.on("unhandledRejection", (err) => {
		log.error({ msg: "unhandled rejection", ...errFields(err) });
	});

	await poller.run();
	if (fatal) {
		log.error({ msg: "exiting on fatal polling error", ...errFields(fatal) });
		process.exit(EXIT_CONFIG_FAULT);
	}
}

main().catch((err: unknown) => {
	log.error({ msg: "startup failed", ...errFields(err) });
	process.exit(err instanceof TgError && err.kind === "fatal" ? EXIT_CONFIG_FAULT : 1);
});
