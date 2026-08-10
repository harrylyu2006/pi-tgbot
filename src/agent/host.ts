/**
 * Owns the single AgentSession.
 *
 * Everything here is written against behavior observed by scripts/probe.ts on
 * pi 0.84.1, not against the docstrings. Two findings shaped this file:
 *
 *  - Extension tools (web_search, fetch_content, …) are already registered AND
 *    active when createAgentSession() resolves. bindExtensions() is still
 *    called, but for the abort/shutdown handlers — not for tool registration.
 *  - createAgentSession()'s default SessionManager mints a fresh session per
 *    boot, and continueRecent(cwd) would pick up whatever session the operator
 *    last used in an interactive pi. Both are wrong for a daemon, so we pin our
 *    own session directory.
 */

import { mkdirSync } from "node:fs";
import { errFields, type Logger } from "../log.ts";
import type { Config } from "../config.ts";

// The SDK ships .d.ts that pull in its own module graph; typing it precisely
// here would couple us to internals we deliberately do not depend on. The
// surface we use is small and probe-verified, so it is declared locally.
interface PiSession {
	subscribe(listener: (event: any) => void): () => void;
	bindExtensions(bindings: Record<string, unknown>): Promise<void>;
	prompt(text: string, options?: Record<string, unknown>): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getAllTools(): Array<{ name: string }>;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	getContextUsage(): { tokens: number; contextWindow: number; percent: number };
	getSessionStats(): Record<string, unknown>;
	getAvailableThinkingLevels(): string[];
	supportsThinking(): boolean;
	readonly model: { provider: string; id: string };
	readonly thinkingLevel: string;
	readonly sessionId: string;
	readonly isIdle: boolean;
	readonly pendingMessageCount: number;
	readonly isCompacting: boolean;
}

export interface AgentHostDeps {
	config: Config;
	log: Logger;
	/** Receives every session event, tagged with the generation it belongs to. */
	onEvent: (generation: number, event: any) => void;
	onAbortRequested: () => void;
	onShutdownRequested: () => void;
	/** Extra tools registered alongside the built-ins (e.g. telegram_send_file). */
	customTools?: unknown[];
	/**
	 * UI context handed to extensions. Supplying one makes `ctx.hasUI` true, so
	 * extensions that would otherwise fail closed can ask the operator instead.
	 */
	uiContext?: unknown;
}

export class AgentHost {
	private readonly deps: AgentHostDeps;
	private readonly log: Logger;
	private pi: any = null;
	private loader: any = null;
	private settingsManager: any = null;

	private sessionValue: PiSession | null = null;
	private unsubscribe: (() => void) | null = null;
	private generationValue = 0;

	constructor(deps: AgentHostDeps) {
		this.deps = deps;
		this.log = deps.log;
	}

	get session(): PiSession {
		if (!this.sessionValue) throw new Error("agent session not started");
		return this.sessionValue;
	}

	get generation(): number {
		return this.generationValue;
	}

	async start(): Promise<void> {
		const cfg = this.deps.config;
		mkdirSync(cfg.sessionDir, { recursive: true });

		this.pi = await import("@earendil-works/pi-coding-agent");
		this.settingsManager = this.pi.SettingsManager.create(cfg.cwd, cfg.agentDir);

		// noExtensions + an explicit allowlist means @llblab/pi-telegram's module
		// is never imported. Filtering after discovery would be too late: the
		// extension would already have run and started competing for our bot
		// token on the same getUpdates slot.
		this.loader = new this.pi.DefaultResourceLoader({
			cwd: cfg.cwd,
			agentDir: cfg.agentDir,
			settingsManager: this.settingsManager,
			noExtensions: true,
			additionalExtensionPaths: cfg.extensions,
		});
		await this.loader.reload();

		const loaded = this.loader.getExtensions();
		const paths = (loaded.extensions ?? []).map((e: any) => String(e.resolvedPath ?? e.path));
		if (paths.some((p: string) => /pi-telegram/.test(p))) {
			throw new Error("refusing to start: a pi-telegram extension loaded and would contend for the bot token");
		}
		this.log.info({ msg: "extensions loaded", paths, errors: loaded.errors ?? [] });

		await this.createSession(false);
	}

	/**
	 * @param fresh true only for `/new`. On boot we resume instead.
	 *
	 * `SessionManager.create()` mints a brand-new session every call, so using it
	 * at startup silently discarded the conversation on every restart — the
	 * locked requirement is one long-lived session that only `/new` resets.
	 * `continueRecent` reattaches to the newest session in our dedicated dir.
	 */
	private async createSession(fresh: boolean): Promise<void> {
		const cfg = this.deps.config;
		const sessionManager = fresh
			? this.pi.SessionManager.create(cfg.cwd, cfg.sessionDir)
			: this.pi.SessionManager.continueRecent(cfg.cwd, cfg.sessionDir);

		const created = await this.pi.createAgentSession({
			cwd: cfg.cwd,
			agentDir: cfg.agentDir,
			resourceLoader: this.loader,
			sessionManager,
			excludeTools: cfg.tools.deny,
			customTools: this.deps.customTools ?? [],
		});

		const session = created.session as PiSession;
		this.sessionValue = session;
		const generation = ++this.generationValue;

		if (created.modelFallbackMessage) this.log.warn({ msg: "model fallback", detail: created.modelFallbackMessage });

		if (cfg.model) await this.applyModelOverride(session, cfg.model);

		// Subscribe before binding so nothing emitted during session_start is lost.
		this.unsubscribe = session.subscribe((event: any) => this.deps.onEvent(generation, event));

		await session.bindExtensions({
			...(this.deps.uiContext ? { uiContext: this.deps.uiContext } : {}),
			abortHandler: () => this.deps.onAbortRequested(),
			shutdownHandler: () => this.deps.onShutdownRequested(),
			onError: (err: unknown) => this.log.warn({ msg: "extension error", ...errFields(err) }),
		});

		// Built-ins grep/find/ls ship registered but inactive; extension tools are
		// already active (probe-verified), so this sweep only widens the base set.
		const deny = new Set(cfg.tools.deny);
		const want = new Set<string>([...session.getActiveToolNames(), ...cfg.tools.extraActive]);
		const active = [...want].filter((n) => !deny.has(n));
		session.setActiveToolsByName(active);

		this.log.info({
			msg: "session ready",
			generation,
			sessionId: session.sessionId,
			model: `${session.model.provider}/${session.model.id}`,
			thinking: session.supportsThinking() ? session.thinkingLevel : "unsupported",
			activeTools: session.getActiveToolNames(),
			contextWindow: session.getContextUsage().contextWindow,
		});
	}

	/**
	 * Point this session at a specific "provider/id".
	 *
	 * A miss is a warning, not a throw: falling back to the settings.json model
	 * keeps the bot answering, whereas refusing to boot over a typo in an
	 * optional field would take the whole daemon down.
	 */
	private async applyModelOverride(session: PiSession, spec: string): Promise<void> {
		const slash = spec.indexOf("/");
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		try {
			const runtime = (session as unknown as { modelRuntime: { getAvailable(p?: string): Promise<readonly any[]> } }).modelRuntime;
			const available = await runtime.getAvailable();
			const match = available.find((m) => m.provider === provider && m.id === id);
			if (!match) {
				this.log.warn({
					msg: "configured model not found, keeping settings.json default",
					wanted: spec,
					available: available.map((m) => `${m.provider}/${m.id}`).slice(0, 20),
				});
				return;
			}
			await (session as unknown as { setModel(m: unknown): Promise<void> }).setModel(match);
			this.log.info({ msg: "model override applied", model: spec });
		} catch (err) {
			this.log.warn({ msg: "model override failed, keeping default", wanted: spec, ...errFields(err) });
		}
	}

	/** Panel-driven model switch. Returns false rather than throwing at the UI. */
	async setModelSpec(spec: string): Promise<boolean> {
		if (!this.sessionValue) return false;
		try {
			await this.applyModelOverride(this.sessionValue, spec);
			return `${this.sessionValue.model.provider}/${this.sessionValue.model.id}` === spec;
		} catch (err) {
			this.log.warn({ msg: "panel model switch failed", spec, ...errFields(err) });
			return false;
		}
	}

	/** Panel-driven thinking level switch. */
	setThinking(level: string): boolean {
		const session = this.sessionValue;
		if (!session || !session.supportsThinking()) return false;
		if (!session.getAvailableThinkingLevels().includes(level)) return false;
		try {
			(session as unknown as { setThinkingLevel(l: string): void }).setThinkingLevel(level);
			this.log.info({ msg: "thinking level changed", level });
			return true;
		} catch (err) {
			this.log.warn({ msg: "thinking switch failed", level, ...errFields(err) });
			return false;
		}
	}

	/** `/new`: drop the current session and start a clean one. */
	async reset(): Promise<void> {
		const old = this.sessionValue;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.sessionValue = null;
		try {
			old?.dispose();
		} catch (err) {
			this.log.warn({ msg: "dispose during reset failed", ...errFields(err) });
		}
		await this.createSession(true);
	}

	async stop(): Promise<void> {
		try {
			await Promise.race([this.sessionValue?.abort() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 10_000).unref?.())]);
		} catch (err) {
			this.log.warn({ msg: "abort during shutdown failed", ...errFields(err) });
		}
		this.unsubscribe?.();
		try {
			this.sessionValue?.dispose();
		} catch {
			/* shutting down anyway */
		}
		this.sessionValue = null;
	}
}
