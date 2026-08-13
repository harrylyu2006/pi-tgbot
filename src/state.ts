/**
 * Durable state that must survive a restart.
 *
 * Deliberately NOT a write-ahead spool. Telegram keeps the confirmed offset
 * server-side, so a restart already hands us only unconfirmed updates — there
 * is nothing for us to persist about polling position. What a restart *can*
 * break is narrower:
 *
 *   1. An update we processed but had not yet confirmed gets redelivered, and
 *      we answer it twice. Hence the seen-id set.
 *   2. A backlog that accumulated while we were down gets executed all at once.
 *      With full tools as root that is the worst failure mode available, hence
 *      the staleness cutoff.
 *   3. A turn killed mid-flight leaves the operator staring at a dead "⏳".
 *      Hence the interrupted-turn record.
 *
 * The set is a bounded FIFO, not an `id > lastSeen` comparison: update ids are
 * not guaranteed monotonic forever, and a comparison silently eats messages
 * after the bot has been quiet long enough for ids to be reassigned.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errFields, type Logger } from "./log.ts";

const MAX_SEEN = 512;

export interface InterruptedTurn {
	chatId: number;
	messageId: number;
	startedAt: number;
}

/** Operator choices that must survive both process restarts and `/new`. */
export interface AgentPreferences {
	model?: string;
	thinkingLevel?: string;
}

interface Persisted {
	seen: number[];
	interrupted?: InterruptedTurn | null;
	agentPreferences?: AgentPreferences;
}

export class State {
	private readonly path: string;
	private readonly log: Logger;
	private seen: number[] = [];
	private seenSet = new Set<number>();
	private interruptedValue: InterruptedTurn | null = null;
	private agentPreferencesValue: AgentPreferences = {};

	constructor(path: string, log: Logger) {
		this.path = path;
		this.log = log;
	}

	load(): void {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
			this.seen = Array.isArray(raw.seen) ? raw.seen.filter((n) => typeof n === "number").slice(-MAX_SEEN) : [];
			this.seenSet = new Set(this.seen);
			this.interruptedValue = raw.interrupted ?? null;
			const saved = raw.agentPreferences;
			this.agentPreferencesValue = {
				...(typeof saved?.model === "string" && saved.model.includes("/") ? { model: saved.model } : {}),
				...(typeof saved?.thinkingLevel === "string" && saved.thinkingLevel ? { thinkingLevel: saved.thinkingLevel } : {}),
			};
			this.log.info({
				msg: "state loaded",
				seen: this.seen.length,
				interrupted: Boolean(this.interruptedValue),
				hasModelPreference: Boolean(this.agentPreferencesValue.model),
				hasThinkingPreference: Boolean(this.agentPreferencesValue.thinkingLevel),
			});
		} catch {
			// A missing or corrupt file is a first boot, not an error worth dying
			// over — the cost is at most one duplicate answer.
			this.log.info({ msg: "no prior state, starting fresh" });
		}
	}

	private persist(): void {
		const payload: Persisted = {
			seen: this.seen,
			interrupted: this.interruptedValue,
			agentPreferences: this.agentPreferencesValue,
		};
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp`;
			writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
			renameSync(tmp, this.path); // atomic: a crash mid-write cannot truncate the live file
		} catch (err) {
			this.log.warn({ msg: "state persist failed", ...errFields(err) });
		}
	}

	alreadySeen(updateId: number): boolean {
		return this.seenSet.has(updateId);
	}

	markSeen(updateId: number): void {
		if (this.seenSet.has(updateId)) return;
		this.seen.push(updateId);
		this.seenSet.add(updateId);
		while (this.seen.length > MAX_SEEN) {
			const dropped = this.seen.shift();
			if (dropped !== undefined) this.seenSet.delete(dropped);
		}
		this.persist();
	}

	get interrupted(): InterruptedTurn | null {
		return this.interruptedValue;
	}

	get agentPreferences(): Readonly<AgentPreferences> {
		return { ...this.agentPreferencesValue };
	}

	/** Persist only supplied fields, preserving the other operator choices. */
	setAgentPreferences(patch: AgentPreferences): void {
		const next = { ...this.agentPreferencesValue, ...patch };
		if (
			next.model === this.agentPreferencesValue.model &&
			next.thinkingLevel === this.agentPreferencesValue.thinkingLevel
		) {
			return;
		}
		this.agentPreferencesValue = next;
		this.persist();
	}

	beginTurn(turn: InterruptedTurn): void {
		this.interruptedValue = turn;
		this.persist();
	}

	endTurn(): void {
		if (this.interruptedValue === null) return;
		this.interruptedValue = null;
		this.persist();
	}

	clearInterrupted(): void {
		this.endTurn();
	}
}
