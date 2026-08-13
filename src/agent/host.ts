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
import { fileURLToPath } from "node:url";
import { errFields, type Logger } from "../log.ts";
import type { Config } from "../config.ts";
import type { AgentPreferences } from "../state.ts";
import { availableLevelsFor, enrichThinkingLevels, preferredDefaultThinkingLevelFor, type ModelLike } from "./reasoning.ts";

const BUILTIN_EXTENSIONS = [fileURLToPath(new URL("../../node_modules/pi-web-access", import.meta.url))];
const BUILTIN_EXTENSION_PACKAGES = /^npm:pi-web-access(?:@|$)/;

// The SDK ships .d.ts that pull in its own module graph; typing it precisely
// here would couple us to internals we deliberately do not depend on. The
// surface we use is small and probe-verified, so it is declared locally.
interface PiSession {
	subscribe(listener: (event: any) => void): () => void;
	bindExtensions(bindings: Record<string, unknown>): Promise<void>;
	prompt(text: string, options?: Record<string, unknown>): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	readonly extensionRunner: {
		hasHandlers(eventType: string): boolean;
		emit(event: Record<string, unknown>): Promise<unknown>;
	};
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
	/** Last successful operator choices, loaded before the session starts. */
	loadPreferences?: () => Readonly<AgentPreferences>;
	/** Persist a successful model/thinking change immediately. */
	savePreferences?: (patch: AgentPreferences) => void;
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
		const configuredExtensions = cfg.extensions.filter((extension) => !BUILTIN_EXTENSION_PACKAGES.test(extension));
		const extensionPaths = [...new Set([...BUILTIN_EXTENSIONS, ...configuredExtensions])];
		this.loader = new this.pi.DefaultResourceLoader({
			cwd: cfg.cwd,
			agentDir: cfg.agentDir,
			settingsManager: this.settingsManager,
			noExtensions: true,
			additionalExtensionPaths: extensionPaths,
		});
		await this.loader.reload();

		const loaded = this.loader.getExtensions();
		const paths = (loaded.extensions ?? []).map((e: any) => String(e.resolvedPath ?? e.path));
		if (paths.some((p: string) => /pi-telegram/.test(p))) {
			throw new Error("refusing to start: a pi-telegram extension loaded and would contend for the bot token");
		}
		this.log.info({ msg: "extensions loaded", extensionCount: paths.length, extensionErrorCount: (loaded.errors ?? []).length });

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

		if (created.modelFallbackMessage) this.log.warn({ msg: "model fallback" });

		// Durable operator choices beat config/settings defaults. This is applied on
		// both daemon startup and `/new`, so clearing context never resets controls.
		const preferences = this.deps.loadPreferences?.() ?? {};
		const wantedModel = preferences.model ?? cfg.model;
		if (wantedModel) await this.applyModelOverride(session, wantedModel);

		// The settings.json default model carries no map either; apply the same
		// keyword inference so the startup model and the panel agree.
		await this.enrichCurrentModel(session);

		if (preferences.thinkingLevel) {
			const restored = this.applyThinkingLevel(session, preferences.thinkingLevel, "restored");
			if (!restored) {
				const preferredDefault = preferredDefaultThinkingLevelFor(session.model as unknown as ModelLike);
				if (preferredDefault) this.applyThinkingLevel(session, preferredDefault, "default");
			}
		} else {
			const preferredDefault = preferredDefaultThinkingLevelFor(session.model as unknown as ModelLike);
			if (preferredDefault) this.applyThinkingLevel(session, preferredDefault, "default");
		}

		// Subscribe before binding so nothing emitted during session_start is lost.
		this.unsubscribe = session.subscribe((event: any) => this.deps.onEvent(generation, event));

		await session.bindExtensions({
			...(this.deps.uiContext ? { uiContext: this.deps.uiContext } : {}),
			abortHandler: () => this.deps.onAbortRequested(),
			shutdownHandler: () => this.deps.onShutdownRequested(),
			onError: (err: unknown) => {
				this.log.warn({ msg: "extension error", ...errFields(err) });
				// Surface it as a session event so the live activity row can show it.
				this.deps.onEvent(this.generationValue, { type: "extension_error", error: err instanceof Error ? err.message : String(err) });
			},
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
			thinkingLevels: session.getAvailableThinkingLevels(),
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
			const enriched = enrichThinkingLevels(match);
			await (session as unknown as { setModel(m: unknown): Promise<void> }).setModel(enriched);
			this.log.info({ msg: "model override applied", model: spec, thinkingLevels: availableLevelsFor(enriched).join(",") });
		} catch (err) {
			this.log.warn({ msg: "model override failed, keeping default", wanted: spec, ...errFields(err) });
		}
	}

	/**
	 * Enrich the model the session booted with (settings.json default, or the
	 * fallback when the configured override was not found). No-op unless the
	 * keyword rules produce a map the session did not already carry.
	 */
	private async enrichCurrentModel(session: PiSession): Promise<void> {
		try {
			const current = session.model as unknown as ModelLike;
			const enriched = enrichThinkingLevels(current);
			if (enriched === current) return;
			await (session as unknown as { setModel(m: unknown): Promise<void> }).setModel(enriched);
			this.log.info({
				msg: "thinking levels enriched for default model",
				model: `${enriched.provider}/${enriched.id}`,
				levels: availableLevelsFor(enriched).join(","),
			});
		} catch (err) {
			this.log.warn({ msg: "thinking level enrichment failed, keeping SDK defaults", ...errFields(err) });
		}
	}

	private applyThinkingLevel(session: PiSession, level: string, source: "panel" | "restored" | "default"): boolean {
		if (!session.supportsThinking()) return false;
		if (!session.getAvailableThinkingLevels().includes(level)) {
			this.log.warn({
				msg: "thinking preference unsupported by current model",
				level,
				model: `${session.model.provider}/${session.model.id}`,
				available: session.getAvailableThinkingLevels(),
				source,
			});
			return false;
		}
		try {
			(session as unknown as { setThinkingLevel(l: string): void }).setThinkingLevel(level);
			this.log.info({
				msg: source === "panel" ? "thinking level changed" : source === "restored" ? "thinking level restored" : "provider thinking default applied",
				level,
			});
			return true;
		} catch (err) {
			this.log.warn({ msg: "thinking switch failed", level, source, ...errFields(err) });
			return false;
		}
	}

	/** Panel-driven model switch. Returns false rather than throwing at the UI. */
	async setModelSpec(spec: string): Promise<boolean> {
		if (!this.sessionValue) return false;
		try {
			await this.applyModelOverride(this.sessionValue, spec);
			const ok = `${this.sessionValue.model.provider}/${this.sessionValue.model.id}` === spec;
			if (ok) {
				// setModel may clamp the old reasoning level for the new model. Save the
				// effective pair atomically so `/new` restores a valid combination.
				this.deps.savePreferences?.({ model: spec, thinkingLevel: this.sessionValue.thinkingLevel });
			}
			return ok;
		} catch (err) {
			this.log.warn({ msg: "panel model switch failed", spec, ...errFields(err) });
			return false;
		}
	}

	/** Panel-driven thinking level switch. */
	setThinking(level: string): boolean {
		const session = this.sessionValue;
		if (!session || !this.applyThinkingLevel(session, level, "panel")) return false;
		this.deps.savePreferences?.({
			model: `${session.model.provider}/${session.model.id}`,
			thinkingLevel: session.thinkingLevel,
		});
		return true;
	}

	/**
	 * Tear down one SDK session in lifecycle order.
	 *
	 * AgentSession.dispose() only invalidates the extension runtime; it does not
	 * emit session_shutdown. Emitting it first lets MCP/web extensions close
	 * session-scoped work without touching an already-stale context.
	 */
	private async teardownSession(session: PiSession, reason: "new" | "quit"): Promise<void> {
		try {
			await Promise.race([session.abort(), new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref?.())]);
		} catch (err) {
			this.log.warn({ msg: `abort during ${reason} failed`, ...errFields(err) });
		}

		try {
			if (session.extensionRunner.hasHandlers("session_shutdown")) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason });
			}
		} catch (err) {
			this.log.warn({ msg: `extension shutdown during ${reason} failed`, ...errFields(err) });
		}

		try {
			session.dispose();
		} catch (err) {
			this.log.warn({ msg: `dispose during ${reason} failed`, ...errFields(err) });
		}
	}

	/** `/new`: drop context, but preserve the effective model and reasoning. */
	async reset(): Promise<void> {
		const old = this.sessionValue;
		if (old) {
			this.deps.savePreferences?.({
				model: `${old.model.provider}/${old.model.id}`,
				thinkingLevel: old.thinkingLevel,
			});
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.sessionValue = null;
		if (old) await this.teardownSession(old, "new");

		// DefaultResourceLoader owns a single shared extension runtime. Disposing
		// the old AgentSession invalidates that runtime, so reusing the loader as-is
		// makes every extension context in the replacement session stale. Reloading
		// here creates fresh extension instances/runtime before generation N+1 binds.
		await this.loader.reload();
		await this.createSession(true);
	}

	async stop(): Promise<void> {
		const session = this.sessionValue;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.sessionValue = null;
		if (session) await this.teardownSession(session, "quit");
	}
}
