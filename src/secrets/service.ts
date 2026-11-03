/**
 * Ties the vault, the one-time link server, the output scrubber and the Telegram
 * side together. The agent-facing tools and hooks live in extension.ts.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { esc } from "../telegram/html.ts";
import { errFields, type Logger } from "../log.ts";
import type { TelegramApi } from "../telegram/api.ts";
import type { TelegramUI } from "../ui/telegram-ui.ts";
import { LinkRejected, LinkServer, type LinkOutcome } from "./server.ts";
import { KeepassError, KP_REF, type EntryInfo, type KeepassConfig } from "./keepass-core.ts";
import type { Keepass } from "./keepass.ts";
import { approvalMessage } from "./approval.ts";
import { syncKeepassFromDrive, type Exec, type SyncResult } from "./drive-sync.ts";
import { Scrubber } from "./scrub.ts";
import { NAME_RE, Vault, type SecretMeta } from "./vault.ts";

export interface SecretsConfig {
	/** Public origin of the input page (HTTPS in production). */
	baseUrl: string;
	host: string;
	port: number;
	dir: string;
	keyPath: string;
	linkTtlSeconds: number;
	/** Tools in which `{{secret:NAME}}` is refused rather than substituted. */
	denyPlaceholderTools: string[];
	/** JSONL of who used which secret, never values. */
	auditPath: string;
	/** Read-only KeePass access (optional). */
	keepass?: KeepassConfig;
}

export interface SecretsDeps {
	config: SecretsConfig;
	api: TelegramApi;
	ui: TelegramUI;
	log: Logger;
	/** Private-chat id of the single operator. */
	operatorChatId: number;
	currentChatId: () => number | null;
	/** Test hook: extra Host header values the link server accepts. */
	extraHosts?: string[];
	/**
	 * Called after a value the *agent is not waiting on* has been stored (operator-started
	 * `/secret`, or a `wait:false` request), so the agent learns it arrived. Never carries the value.
	 */
	onSaved?: (event: SavedEvent) => void;
	/** Same idea for an operator-started `/unlock`: tell the agent KeePass is now open. */
	onUnlocked?: (event: UnlockedEvent) => void;
	/** Test hook: replaces the rclone process used for Drive sync. */
	exec?: Exec;
	/**
	 * The KeePass implementation (`./keepass.ts`), supplied by the caller so that the KDBX library is only loaded when
	 * `config.keepass` is set. `SecretsService.create` does this for you.
	 */
	keepassModule?: typeof import("./keepass.ts");
}

export interface UnlockedEvent { entries: number; idleMinutes: number; mode: string; chatId: number; messageId: number }

export function unlockedNotice(e: UnlockedEvent): string {
	return [
		`[系统通知，不是操作员键入的消息] 操作员刚刚解锁了 KeePass（你能看到 ${e.entries} 个条目${e.mode === "session" ? `，空闲 ${e.idleMinutes} 分钟后自动锁定` : ""}）。`,
		`用 keepass_search 按名称/网址找条目（只会返回标题、用户名、网址，不含密码），再用 secret_run 的 env/files 写 "kp:<id>#password"，或在其他工具参数里写 {{secret:kp:<id>#password}} 来使用。`,
		`如果这正是你刚才在等的，就接着做原来的任务；如果当前没有等它的任务，只用一两句话确认「KeePass 已解锁」，并问他想让你做什么，不要自行发起任何操作。`,
	].join("\n");
}

export type UnlockResult =
	| { kind: "unlocked"; detail: string }
	| { kind: "already-unlocked" }
	| { kind: "pending"; expiresAt: number }
	| { kind: "expired" | "cancelled" }
	| { kind: "error"; message: string };

export interface SavedEvent {
	name: string;
	description: string;
	length: number;
	confirm: boolean;
	scrubbable: boolean;
	replacing: boolean;
	origin: "operator" | "agent";
	chatId: number;
	/** The link message, which was just edited to "saved" — the notice replies to it. */
	messageId: number;
}

/** Text handed to the agent as a prompt. Contains the name and metadata only, never the value. */
export function savedNotice(e: SavedEvent): string {
	const desc = e.description.replace(/\s+/g, " ").trim().slice(0, 100);
	const facts = [
		`${e.length} 个字符`,
		e.replacing ? "覆盖了同名旧值" : "新增",
		...(e.confirm ? ["每次使用前需要操作员在 Telegram 确认"] : []),
		...(e.scrubbable ? [] : ["太短，无法从输出里自动擦除"]),
	].join("，");
	return [
		`[系统通知，不是操作员键入的消息] 操作员刚刚通过加密输入页保存了密钥「${e.name}」（${facts}）。${desc ? `用途：${desc}。` : ""}`,
		`你看不到它的值，也不要试图读取。需要时用 secret_run（env/files）或 {{secret:${e.name}}} 占位符使用它。`,
		`如果这正是你刚才在等的凭据，就接着做原来的任务；如果当前没有等它的任务，只用一两句话确认「已收到 ${e.name}」，并问他想用它做什么，不要自行发起任何操作。`,
	].join("\n");
}

export type RequestResult =
	| { kind: "saved"; meta: SecretMeta }
	| { kind: "pending"; expiresAt: number }
	| { kind: "expired" | "cancelled" }
	| { kind: "error"; message: string };

export class SecretsService {
	readonly vault: Vault;
	readonly scrubber = new Scrubber();
	readonly config: SecretsConfig;
	private readonly deps: SecretsDeps;
	private readonly server: LinkServer;
	private readonly log: Logger;
	private started = false;
	readonly keepass: Keepass | null;

	/**
	 * Build the service, loading the KeePass module (and with it the optional `kdbxweb` dependency) only when KeePass is
	 * configured. If that dependency is missing the vault and input page still work and KeePass is switched off with a
	 * clear message in the log, rather than the whole plugin failing.
	 */
	static async create(deps: SecretsDeps): Promise<SecretsService> {
		let keepassModule: SecretsDeps["keepassModule"];
		let config = deps.config;
		if (config.keepass) {
			try { keepassModule = await import("./keepass.ts"); }
			catch (err) {
				deps.log.error({ msg: "KeePass support disabled: could not load the optional dependency 'kdbxweb' (run `npm install`)", err: err instanceof Error ? err.message : String(err) });
				config = { ...config, keepass: undefined };
			}
		}
		return new SecretsService({ ...deps, config, keepassModule: deps.keepassModule ?? keepassModule });
	}

	constructor(deps: SecretsDeps) {
		this.deps = deps;
		this.config = deps.config;
		this.log = deps.log;
		if (deps.config.keepass && !deps.keepassModule) throw new Error("secrets.keepass is configured but the KeePass module was not loaded (use SecretsService.create)");
		this.keepass = deps.config.keepass && deps.keepassModule
			? new deps.keepassModule.Keepass(deps.config.keepass, { onLocked: (reason) => this.afterLock(reason) })
			: null;
		this.vault = new Vault(deps.config.dir, deps.config.keyPath);
		this.vault.onChange(() => this.scrubber.rebuild(this.vault.allValues()));
		this.scrubber.rebuild(this.vault.allValues());
		this.server = new LinkServer({
			host: deps.config.host, port: deps.config.port, baseUrl: deps.config.baseUrl,
			extraHosts: deps.extraHosts, vault: this.vault, log: deps.log.child("link"),
		});
		try {
			mkdirSync(dirname(deps.config.auditPath), { recursive: true, mode: 0o700 });
			closeSync(openSync(deps.config.auditPath, "a", 0o600));
			chmodSync(deps.config.auditPath, 0o600);
		} catch (err) {
			this.log.warn({ msg: "secrets audit log unavailable", ...errFields(err) });
		}
	}

	async start(): Promise<void> {
		await this.server.start();
		this.started = true;
		this.log.info({ msg: "secret input server listening", port: this.server.listeningPort, secrets: this.vault.list().length });
	}

	async stop(): Promise<void> {
		this.keepass?.lock("manual");
		if (this.started) await this.server.stop();
		this.started = false;
	}

	private afterLock(reason: "idle" | "max" | "manual" | "replaced"): void {
		this.audit({ event: "keepass-lock", reason });
		if (reason !== "idle" && reason !== "max") return; // manual/replaced are acknowledged by whoever asked
		const why = reason === "idle" ? `空闲超过 ${this.keepass?.cfg.idleMinutes} 分钟` : `已达 ${this.keepass?.cfg.maxHours} 小时上限`;
		void this.deps.api.sendMessage({ chat_id: this.deps.operatorChatId, text: `🔒 KeePass 已自动锁定（${why}）。需要时 /unlock。` }).catch(() => undefined);
	}

	get port(): number {
		return this.server.listeningPort;
	}

	/** Chat to address: the running turn's, else the operator's private chat. */
	operatorChat(): number {
		return this.deps.currentChatId() ?? this.deps.operatorChatId;
	}

	async confirmDelete(name: string): Promise<boolean> {
		return this.deps.ui.confirm(`删除密钥「${name}」？`, "AI 请求删除这个已保存的密钥。删除后需要你重新输入。");
	}

	/** For the outbound (Telegram) redactor. */
	scrubText = (text: string): string => this.scrubber.scrub(text);

	audit(record: Record<string, unknown>): void {
		try {
			appendFileSync(this.config.auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
		} catch (err) {
			this.log.warn({ msg: "secrets audit write failed", ...errFields(err) });
		}
	}

	/**
	 * Mint a link and put it in front of the operator as a button (the URL is never in message text).
	 * `finish` rewrites that message once the link settles, which is also what removes the URL from the chat.
	 */
	private async openLink(input: { kind: "secret" | "unlock"; name: string; description: string; chatId: number; note?: string; sink?: Parameters<LinkServer["createLink"]>[0]["sink"] }):
		Promise<{ link: Awaited<ReturnType<LinkServer["createLink"]>>; messageId: number } | { error: string }> {
		if (!this.started) return { error: "the secret input server is not running (check the pi-tg journal); nothing was sent" };
		let link;
		try {
			link = await this.server.createLink({ name: input.name, description: input.description, ttlMs: this.config.linkTtlSeconds * 1000, sink: input.sink });
		} catch (err) {
			return { error: `could not create link: ${err instanceof Error ? err.message : String(err)}` };
		}
		const minutes = Math.round(this.config.linkTtlSeconds / 60);
		const unlock = input.kind === "unlock";
		const head = unlock ? "🔓 <b>需要解锁 KeePass</b>" : `🔐 <b>需要安全输入：</b><code>${esc(input.name)}</code>`;
		const how = unlock
			? "点下面的按钮，在网页里输入 KeePass 主密码（加密传输；只放内存、不写磁盘，不会进聊天记录，也不会给 AI 看到）。"
			: "点下面的按钮在网页里输入（加密传输，不会进聊天记录，也不会给 AI 看到）。";
		const body = `${head}${input.description ? `\n用途：${esc(input.description)}` : ""}${input.note ? `\n${esc(input.note)}` : ""}\n\n${how}${minutes} 分钟内有效，只能用一次。`;
		try {
			const sent = await this.deps.api.sendMessage({
				chat_id: input.chatId, text: body, parse_mode: "HTML", protect_content: true,
				link_preview_options: { is_disabled: true },
				reply_markup: { inline_keyboard: [[{ text: unlock ? "🔓 打开解锁页" : "🔐 打开安全输入页", url: link.url }]] },
			});
			return { link, messageId: sent.message_id };
		} catch (err) {
			link.cancel();
			return { error: `could not send the link to Telegram: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private editLinkMessage(chatId: number, messageId: number, text: string): Promise<unknown> {
		return this.deps.api.editMessageText({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
			.catch((err) => this.log.warn({ msg: "could not edit secret link message", ...errFields(err) }));
	}

	/**
	 * Ask the operator for a value. The value itself is never returned; callers only learn that it was stored.
	 */
	async request(input: { name: string; description: string; chatId: number; wait: boolean; signal?: AbortSignal; origin: string }): Promise<RequestResult> {
		if (!this.started) return { kind: "error", message: "the secret input server is not running (check the pi-tg journal); nothing was sent" };
		if (!NAME_RE.test(input.name)) return { kind: "error", message: "name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}" };
		const replacing = this.vault.has(input.name);
		const opened = await this.openLink({ kind: "secret", name: input.name, description: input.description, chatId: input.chatId });
		if ("error" in opened) return { kind: "error", message: opened.error };
		const { link, messageId } = opened;
		this.audit({ event: "request", name: input.name, origin: input.origin });

		const finish = async (outcome: LinkOutcome): Promise<void> => {
			const text = outcome.status === "saved"
				? `✅ 已安全保存：<code>${esc(input.name)}</code>（${outcome.meta.length} 个字符）${outcome.meta.confirm ? "\n🔒 每次使用都会先问你确认。" : ""}${outcome.meta.scrubbable ? "" : "\n⚠️ 值很短，无法从输出里自动擦除。"}`
				: outcome.status === "expired" ? `⏱ <code>${esc(input.name)}</code> 的输入链接已过期，没有保存任何内容。`
				: `⏹ <code>${esc(input.name)}</code> 的输入链接已取消。`;
			if (outcome.status === "saved") this.audit({ event: "set", name: input.name, origin: input.origin });
			await this.editLinkMessage(input.chatId, messageId, text);
			// An agent that is blocked inside secret_request already gets the outcome as its tool result.
			// Everyone else (operator-started links, wait:false) is told here, after the chat shows "saved".
			if (outcome.status === "saved" && !input.wait) {
				try {
					this.deps.onSaved?.({
						name: input.name, description: input.description, length: outcome.meta.length, confirm: outcome.meta.confirm,
						scrubbable: outcome.meta.scrubbable, replacing, origin: input.origin === "operator" ? "operator" : "agent",
						chatId: input.chatId, messageId,
					});
				} catch (err) { this.log.warn({ msg: "saved-notice callback failed", ...errFields(err) }); }
			}
		};

		if (!input.wait) {
			void link.done.then(finish);
			return { kind: "pending", expiresAt: link.expiresAt };
		}
		const onAbort = (): void => link.cancel();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) onAbort();
		try {
			const outcome = await link.done;
			await finish(outcome);
			return outcome.status === "saved" ? { kind: "saved", meta: outcome.meta } : outcome.status === "done" ? { kind: "cancelled" } : { kind: outcome.status };
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
		}
	}

	// ---- KeePass -----------------------------------------------------------------

	/** Open the database with a master password the operator types on a one-time page (session mode), or from the vault (stored mode). */
	async requestUnlock(input: { chatId: number; wait: boolean; signal?: AbortSignal; origin: string; description?: string }): Promise<UnlockResult> {
		const kp = this.keepass;
		if (!kp) return { kind: "error", message: "KeePass is not configured on this service" };
		if (kp.unlocked) return { kind: "already-unlocked" };
		const synced = await this.driveSync();
		const note = this.syncNote(synced);
		if (!kp.fileInfo().exists) return { kind: "error", message: `no KeePass database file is available${synced ? ` (Drive sync: ${synced.message})` : ""}; ask the operator to send the .kdbx file to the bot in Telegram` };
		if (kp.cfg.mode === "stored") {
			const err = await this.ensureKeepass("解锁 KeePass");
			return err ? { kind: "error", message: err } : { kind: "unlocked", detail: `${kp.entryCount} entries` };
		}
		const sink = async (password: string): Promise<{ detail: string; length: number }> => {
			try {
				const n = await kp.unlock(password);
				this.audit({ event: "keepass-unlock", entries: n, origin: input.origin });
				return { detail: `${n} 个条目，空闲 ${kp.cfg.idleMinutes} 分钟后自动锁定`, length: [...password].length };
			} catch (err) {
				if (err instanceof KeepassError) { this.audit({ event: "keepass-unlock-failed", code: err.code, origin: input.origin }); throw new LinkRejected(err.code === "wrong-password" ? "主密码不对，请重新输入。" : err.message); }
				throw err;
			}
		};
		const opened = await this.openLink({ kind: "unlock", name: "KeePass", description: input.description ?? "", chatId: input.chatId, note, sink });
		if ("error" in opened) return { kind: "error", message: opened.error };
		const { link, messageId } = opened;
		this.audit({ event: "keepass-unlock-request", origin: input.origin });
		const finish = async (outcome: LinkOutcome): Promise<void> => {
			const text = outcome.status === "done" ? `🔓 KeePass 已解锁（${esc(outcome.detail)}）。`
				: outcome.status === "expired" ? "⏱ KeePass 解锁链接已过期，数据库仍是锁定状态。"
				: "⏹ KeePass 解锁链接已取消（或输错次数过多），数据库仍是锁定状态。";
			await this.editLinkMessage(input.chatId, messageId, text);
			if (outcome.status === "done" && !input.wait) {
				try { this.deps.onUnlocked?.({ entries: kp.entryCount, idleMinutes: kp.cfg.idleMinutes, mode: kp.cfg.mode, chatId: input.chatId, messageId }); }
				catch (err) { this.log.warn({ msg: "unlock-notice callback failed", ...errFields(err) }); }
			}
		};
		if (!input.wait) { void link.done.then(finish); return { kind: "pending", expiresAt: link.expiresAt }; }
		const onAbort = (): void => link.cancel();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) onAbort();
		try {
			const outcome = await link.done;
			await finish(outcome);
			return outcome.status === "done" ? { kind: "unlocked", detail: outcome.detail } : outcome.status === "saved" ? { kind: "cancelled" } : { kind: outcome.status };
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Make sure KeePass is open before resolving an entry. Returns an explanation if it is not (and cannot be opened without the operator). */
	async ensureKeepass(what: string): Promise<string | null> {
		const kp = this.keepass;
		if (!kp) return "KeePass is not configured on this service.";
		if (kp.unlocked) return null;
		if (kp.cfg.mode === "stored") await this.driveSync();
		if (!kp.fileInfo().exists) return "No KeePass database file has been provided yet. Ask the operator to send the .kdbx file to the bot in Telegram.";
		if (kp.cfg.mode !== "stored") return "KeePass is locked. Call keepass_unlock; the operator then enters the master password on a one-time page. Do not ask for the master password in chat.";
		const name = kp.cfg.storedSecret;
		if (!this.vault.has(name)) return `KeePass is in stored mode but its master password is not saved. Ask the operator to run /secret ${name}.`;
		const blocked = await this.gate([name], { tool: "keepass_unlock", text: what });
		if (blocked) return blocked;
		try {
			const n = await kp.unlock(this.vault.get(name, { touch: true }));
			this.audit({ event: "keepass-unlock", entries: n, origin: "stored" });
			return null;
		} catch (err) { return err instanceof KeepassError ? err.message : "could not open the KeePass database"; }
	}

	private syncing: Promise<SyncResult> | null = null;
	private lastSync: { at: number; result: SyncResult } | null = null;

	/** Fetch the latest database from Drive if sync is configured. Never throws; failures leave the local copy untouched. */
	async driveSync(): Promise<SyncResult | null> {
		const kp = this.keepass, cfg = kp?.cfg.sync;
		if (!kp || !cfg) return null;
		this.syncing ??= syncKeepassFromDrive(kp, cfg, { exec: this.deps.exec }).catch((err): SyncResult => ({ status: "failed", message: `同步出错：${err instanceof Error ? err.message.slice(0, 80) : "未知"}` }))
			.finally(() => { this.syncing = null; });
		const result = await this.syncing;
		this.lastSync = { at: Date.now(), result };
		this.audit({ event: "keepass-sync", status: result.status, driveModTime: result.driveModTime });
		if (result.status === "failed") this.log.warn({ msg: "keepass drive sync failed", detail: result.message });
		return result;
	}

	/** The line shown to the operator with the unlock button. */
	private syncNote(r: SyncResult | null): string {
		if (!r || r.status === "skipped") return "";
		const meta = this.keepass?.meta();
		const local = meta ? `（本机副本${meta.source === "drive" ? "来自 Drive" : "是手动发来的"}，${meta.installedAt.slice(0, 16).replace("T", " ")} UTC）` : "";
		if (r.status === "failed") return `⚠️ 没能从 Drive 同步：${r.message}。${meta ? `这次使用本机已有的副本${local}。` : ""}`;
		return `📥 ${r.message}`;
	}

	/**
	 * KeePass unlock is on demand only. Consume the legacy startup marker silently so old restart
	 * scripts remain compatible, but never sync Drive, create a link, or notify an Agent at startup.
	 * Explicit /unlock and keepass_unlock requests still use requestUnlock() unchanged.
	 */
	async startupUnlock(flagPath: string): Promise<null> {
		try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch { /* best-effort legacy cleanup; never prompt */ }
		return null;
	}

	static isKeepassRef(ref: string): boolean { return KP_REF.test(ref); }

	/** Why a reference cannot be used right now, or null if it can. Never reveals a value. */
	refProblem(ref: string): string | null {
		if (KP_REF.test(ref)) {
			if (!this.keepass) return "KeePass is not configured on this service.";
			if (!this.keepass.unlocked) return "KeePass is locked. Call keepass_unlock first.";
			try { this.keepass.describe(ref); return null; }
			catch (err) { return err instanceof KeepassError ? err.message : "cannot resolve that KeePass reference"; }
		}
		return this.vault.has(ref) ? null : `No such secret: ${ref}. Known: ${this.vault.list().map((s) => s.name).join(", ") || "(none)"}`;
	}

	hasRef(ref: string): boolean { return this.refProblem(ref) === null; }

	/** The secret itself, for the harness only. KeePass values start being scrubbed from output *before* this returns. */
	getRef(ref: string): string {
		if (!KP_REF.test(ref)) return this.vault.get(ref, { touch: true });
		const r = this.keepass!.get(ref);
		if (r.secret) this.scrubber.addEphemeral(`kp:${r.info.id}#${r.field}`, r.value, r.validForSec ? (r.validForSec + 120) * 1000 : Infinity);
		return r.value;
	}

	/** Human label for prompts and the audit log (a title, never a value). */
	labelRef(ref: string): string {
		if (!KP_REF.test(ref)) return ref;
		try { const d = this.keepass!.describe(ref); return `KeePass「${d.info.title}」#${d.field}`; } catch { return ref; }
	}

	/**
	 * Gate for secrets that need the operator's tap: vault entries saved with "confirm each use", KeePass entries
	 * tagged/grouped for it, and any new KeePass entry beyond the per-session budget. The dialog is built here from the real
	 * arguments (see approval.ts), shows all of them, and fails closed: too long to show, no answer, or "no" all mean no.
	 * Returns null when approved (or nothing needs approval), otherwise the message to hand back to the model.
	 */
	async gate(refs: string[], action: { tool: string; text: string }): Promise<string | null> {
		const declined: string[] = [];
		for (const ref of new Set(refs)) {
			let subject: string, reason: string;
			if (KP_REF.test(ref)) {
				let d: { info: EntryInfo; field: string };
				try { d = this.keepass!.describe(ref); } catch { continue; } // an unresolvable ref is reported by the caller
				const over = this.keepass!.overBudget(d.info.id);
				if (!d.info.confirm && !over) continue;
				reason = d.info.confirm ? "这个条目被标记为每次使用都要确认"
					: `这次解锁里 AI 已经用了 ${this.keepass!.usedEntries} 个不同条目（上限 ${this.keepass!.cfg.maxEntriesPerSession}），再用新条目需要你确认——正常登录一般只需要一两个`;
				subject = `KeePass 条目：${d.info.group ? `${d.info.group}/` : ""}${d.info.title}\n用户：${d.info.username || "-"}　网址：${d.info.url || "-"}\n字段：${d.field}`;
			} else {
				if (!this.vault.getMeta(ref)?.confirm) continue;
				reason = "这个密钥被设置为每次使用都要确认";
				subject = `保险库密钥：${ref}`;
			}
			// The dialog goes straight to Telegram, so a value the model happened to type into the command is shown as its marker.
			const msg = approvalMessage({ subject, reason, action: this.scrubText(action.text), tool: action.tool });
			if (!msg.ok) { this.audit({ event: "approval-refused", ref: this.labelRef(ref), why: "too-long", tool: action.tool }); return msg.reason; }
			const title = KP_REF.test(ref) ? `使用 KeePass 条目「${this.keepass!.describe(ref).info.title}」？` : `使用密钥「${ref}」？`;
			const ok = await (this.deps.ui.confirmVerbatim ? this.deps.ui.confirmVerbatim(title, msg.message) : this.deps.ui.confirm(title, msg.message));
			this.audit({ event: "approval", ref: this.labelRef(ref), approved: ok, tool: action.tool });
			if (!ok) declined.push(this.labelRef(ref));
		}
		return declined.length ? `The operator did not approve using: ${declined.join(", ")}. Do not retry; explain what you need it for.` : null;
	}

	/**
	 * Called once the values have actually been handed out. Counts distinct KeePass entries for the session budget and, the first
	 * time each entry/field is used in a session, tells the operator in chat (no tap needed) — the "show which credential is being
	 * used" visibility that mature agent-credential tools give.
	 */
	recordUse(refs: string[], action: { tool: string; text: string }): void {
		const kp = this.keepass;
		if (!kp) return;
		for (const ref of new Set(refs)) {
			if (!KP_REF.test(ref)) continue;
			try {
				const { info, field } = kp.describe(ref);
				if (!kp.noteUse(info.id, field).first) continue;
				const what = this.scrubText(action.text).replace(/\s+/g, " ").trim().slice(0, 160);
				void this.deps.api.sendMessage({
					chat_id: this.deps.operatorChatId, parse_mode: "HTML", link_preview_options: { is_disabled: true },
					text: `🔑 AI 正在使用 KeePass 条目「${esc(info.title)}」的 <code>${esc(field)}</code>\n<code>${esc(action.tool)}</code>：${esc(what)}${action.text.length > 160 ? "…" : ""}`,
				}).catch(() => undefined);
			} catch { /* locked in the meantime: nothing to record */ }
		}
	}

	private searchTimes: number[] = [];
	/** A brake on credential discovery: at most 30 KeePass searches per 10 minutes. */
	allowSearch(now = Date.now()): boolean {
		this.searchTimes = this.searchTimes.filter((t) => now - t < 600_000);
		if (this.searchTimes.length >= 30) return false;
		this.searchTimes.push(now);
		return true;
	}

	/**
	 * A .kdbx the operator sent to the bot becomes the database copy; nothing else about the message is left behind.
	 * Returns the paths that were *not* consumed (so the model still sees ordinary attachments).
	 */
	async handleUploads(paths: string[], chatId: number, messageId: number): Promise<string[]> {
		const kp = this.keepass;
		if (!kp) return paths;
		const rest: string[] = [];
		for (const path of paths) {
			if (!/\.kdbx$/i.test(path)) { rest.push(path); continue; }
			const send = (t: string): Promise<unknown> => this.deps.api.sendMessage({ chat_id: chatId, text: t, link_preview_options: { is_disabled: true } }).catch(() => undefined);
			try {
				const { bytes } = kp.installFile(path);
				try { unlinkSync(path); } catch { /* the inbox sweeper will get it */ }
				this.audit({ event: "keepass-install", bytes });
				const deleted = await this.deps.api.call("deleteMessage", { chat_id: chatId, message_id: messageId }).then(() => true, () => false);
				await send(`📥 已更新 KeePass 数据库副本（${(bytes / 1024).toFixed(1)} KB，格式校验通过，旧副本保留一份 .prev）。\n${deleted ? "为了不把数据库文件留在聊天记录里，我已删除你发的那条消息。" : "请你自己删掉刚才那条带文件的消息（我没能删掉）。"}\n${kp.cfg.sync ? "已配置 Drive 同步：下次 /unlock 时，只有 Drive 上的版本比这份更新才会替换它。\n" : ""}发 /unlock 输入主密码来验证并启用。`);
			} catch (err) {
				await send(`⚠️ 这个文件没有被采用：${err instanceof KeepassError ? err.message : "无法读取"}。`);
			}
		}
		return rest;
	}

	private keepassLine(): string {
		const kp = this.keepass;
		if (!kp) return "";
		const st = kp.status();
		const meta = kp.meta();
		const file = st.file.exists ? `数据库副本 ${(st.file.bytes / 1024).toFixed(1)} KB，${meta?.source === "drive" ? "来自 Drive" : "手动发送"}，更新于 ${new Date(st.file.mtimeMs).toISOString().slice(0, 16).replace("T", " ")} UTC` : "还没有数据库文件（把 .kdbx 发给我，或配置 Drive 同步）";
		const sync = !kp.cfg.sync ? "" : this.lastSync ? ` · Drive 同步：${this.lastSync.result.status === "failed" ? `⚠️失败（${this.lastSync.result.message}）` : this.lastSync.result.status === "updated" ? "刚更新" : "已是最新"}` : " · Drive 同步：开启（/unlock 时拉取）";
		return `🔑 KeePass：${st.unlocked ? `🔓 已解锁，${st.entries} 个条目可见，空闲 ${Math.ceil(st.idleLeftSec / 60)} 分钟后锁定` : "🔒 已锁定"}（${st.mode === "stored" ? "主密码存在保险库" : "会话解锁"}）· ${file}${sync}\n\n`;
	}

	formatList(): string {
		const list = this.vault.list();
		if (!list.length) return `${this.keepassLine()}保险库是空的。用 /secret 名称 来添加。`.trim();
		return this.keepassLine() + list.map((s) => {
			const used = s.lastUsed ? `用过 ${s.uses} 次，最近 ${s.lastUsed.slice(0, 16).replace("T", " ")} UTC` : "还没用过";
			return `• ${s.name}${s.description ? ` — ${s.description}` : ""}\n  ${s.length} 字符 · ${used}${s.confirm ? " · 🔒每次确认" : ""}${s.scrubbable ? "" : " · ⚠️太短不擦除"}`;
		}).join("\n");
	}

	/**
	 * Operator commands, handled before any model involvement:
	 *   /secret NAME        mint an input link
	 *   /secret del NAME    delete
	 *   /secrets            list names (never values)
	 * Returns true when the message was consumed.
	 */
	async handleCommand(text: string, chatId: number, messageId: number): Promise<boolean> {
		const m = /^\/(secrets?|unlock|lock)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!m) return false;
		const send = (t: string): Promise<unknown> => this.deps.api.sendMessage({ chat_id: chatId, text: t, link_preview_options: { is_disabled: true } }).catch(() => undefined);
		if (m[1] === "unlock" || m[1] === "lock") {
			if (!this.keepass) { await send("没有配置 KeePass（config.json 的 secrets.keepass）。"); return true; }
			if (m[1] === "lock") { await send(this.keepass.lock("manual") ? "🔒 KeePass 已锁定。" : "KeePass 本来就是锁定的。"); return true; }
			if ((m[2] ?? "").trim()) {
				// Someone typed the master password after /unlock. Pull it out of the chat history.
				await this.deps.api.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined);
				await send("⚠️ /unlock 后面不要带任何内容，我已经把这条消息删掉了。主密码只在我发给你的网页里输入。\n如果刚才那是真的主密码，建议之后改掉它。");
				return true;
			}
			const res = await this.requestUnlock({ chatId, wait: false, origin: "operator" });
			if (res.kind === "already-unlocked") await send("🔓 KeePass 已经是解锁状态。");
			else if (res.kind === "error") await send(`⚠️ ${res.message}`);
			return true;
		}
		if (m[1] === "secrets") { await send(this.formatList()); return true; }
		const args = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
		if (args.length === 0) { await send("用法：\n/secret 名称 — 生成一次性加密输入链接\n/secret del 名称 — 删除\n/secrets — 列出已存的名称（不显示值）\n/unlock、/lock — 解锁/锁定 KeePass\n\n只写名称，别把密码写在这条消息里。"); return true; }
		if (args[0] === "del" && args.length === 2) {
			const ok = this.vault.delete(args[1]!);
			if (ok) this.audit({ event: "delete", name: args[1], origin: "operator" });
			await send(ok ? `🗑 已删除 ${args[1]}` : `没有叫 ${args[1]} 的密钥。`);
			return true;
		}
		if (args.length !== 1 || args[0] === "del") {
			// Looks like the operator typed the secret itself into the chat. Pull it back out.
			await this.deps.api.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined);
			await send("⚠️ 这条消息看起来带了多余内容，我已经把它删掉了。命令只要名称：/secret 名称\n如果刚才那是真密码，建议之后改掉它。");
			return true;
		}
		const res = await this.request({ name: args[0]!, description: "", chatId, wait: false, origin: "operator" });
		if (res.kind === "error") await send(`⚠️ ${res.message}`);
		return true;
	}
}
