import { IdleWatchdog } from "./idle-watchdog.ts";
import { steerIfStreaming } from "./incoming.ts";
import { errFields, type Logger } from "../log.ts";
import type { LiveMessage } from "../telegram/live.ts";

interface Session {
	readonly isStreaming: boolean;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
}
export interface IncomingTask { text: string; chatId: number; replyTo: number }
interface Job {
	item: IncomingTask;
	session: Session;
	live: LiveMessage;
	started: boolean;
	cancelled: boolean;
	finalText?: string;
	settled: Promise<void>;
	resolve: () => void;
}
interface DispatcherDeps {
	host: { readonly session: Session; reset(): Promise<void> };
	log: Logger;
	idleTimeoutMs: number;
	createLive(item: IncomingTask): LiveMessage;
	onBegin(item: IncomingTask, live: LiveMessage): void;
	onEnd(delivered: boolean): void;
}

/** Own both the model run and its final delivery. Control operations are serialized. */
export class Dispatcher {
	private readonly deps: DispatcherDeps;
	private readonly watchdog: IdleWatchdog;
	private queue: IncomingTask[] = [];
	private job: Job | null = null;
	private task: Promise<void> | null = null;
	private control: Promise<void> | null = null;
	private resetPending: Promise<void> | null = null;
	private controls = 0;
	private paused = false;
	private stopped = false;
	constructor(deps: DispatcherDeps) {
		this.deps = deps;
		this.watchdog = new IdleWatchdog(deps.idleTimeoutMs, () => { void this.abort().catch(() => undefined); });
	}
	get busy(): boolean { return this.job !== null || this.paused; }
	get queueDepth(): number { return this.queue.length; }
	get current(): LiveMessage | null { return this.job?.live ?? null; }
	get currentChatId(): number | null { return this.job?.item.chatId ?? null; }
	noteActivity(): void { if (this.job && this.job.finalText === undefined) this.watchdog.touch(); }
	markStarted(): void {
		const job = this.job;
		if (!job) return;
		job.started = true;
		// Handles reset/stop arriving during prompt preflight, before streaming begins.
		if (job.cancelled) void job.session.abort().catch(() => undefined);
	}
	markSettled(text: string): void {
		if (!this.job) return;
		this.job.finalText = text;
		this.watchdog.stop();
		this.job.resolve();
	}
	enqueue(item: IncomingTask): void {
		if (this.stopped) return;
		this.noteActivity();
		const job = this.job;
		if (!this.paused && job && !job.cancelled && job.finalText === undefined && job.session.isStreaming) {
			void steerIfStreaming(job.session, item.text).then((ok) => {
				if (!ok) { this.queue.push(item); this.pump(); }
			}, () => { this.queue.push(item); this.pump(); });
			return;
		}
		this.queue.push(item);
		this.pump();
	}
	private pump(): void {
		if (this.task || this.paused || this.stopped) return;
		const item = this.queue.shift();
		if (!item) return;
		let resolve!: () => void;
		const settled = new Promise<void>((r) => { resolve = r; });
		const job: Job = { item, session: this.deps.host.session, live: this.deps.createLive(item), started: false, cancelled: false, settled, resolve };
		job.live.setPrompt(item.text);
		this.job = job;
		let delivered = false;
		this.task = this.run(job).then((ok) => { delivered = ok; }).catch((err) => this.deps.log.error({ msg: "dispatcher failure", ...errFields(err) })).finally(() => {
			this.watchdog.stop();
			this.deps.onEnd(delivered);
			this.job = null;
			this.task = null;
			this.pump();
		});
	}
	private async run(job: Job): Promise<boolean> {
		try {
			await job.live.begin();
			this.deps.onBegin(job.item, job.live);
			this.noteActivity();
			if (!job.cancelled) {
				await job.session.prompt(job.item.text);
				// Commands/input hooks can handle a prompt without starting an agent.
				// A real run still must reach agent_settled, never just agent_end.
				if (job.started || job.session.isStreaming) await job.settled;
			}
		} catch (err) {
			this.deps.log.error({ msg: "turn failed", ...errFields(err) });
			job.finalText = "⚠️ 这一轮失败了。详细错误已隐藏，请检查服务状态。";
		}
		this.watchdog.stop();
		const delivery = await job.live.finish(job.cancelled ? "⏹ 本轮已中断，可能已执行部分操作。" : job.finalText ?? "✅ 指令已处理（未启动模型回答）。");
		return delivery.complete;
	}
	async abort(): Promise<void> {
		const job = this.job;
		if (!job || job.finalText !== undefined) return;
		job.cancelled = true;
		await job.session.abort();
	}
	/** Reset/control holds admissions until old run AND delivery have completed. */
	exclusive(action: () => Promise<void>, cancel = false): Promise<void> {
		const previous = this.control;
		this.controls++;
		this.paused = true;
		const control = (async () => {
			await previous?.catch(() => undefined);
			if (cancel) await this.abort();
			await this.task;
			await action();
		})().finally(() => {
			this.controls--;
			if (this.control === control) this.control = null;
			this.paused = this.controls > 0 || this.stopped;
			this.pump();
		});
		this.control = control;
		return control;
	}
	reset(): Promise<void> {
		if (!this.resetPending) this.resetPending = this.exclusive(() => this.deps.host.reset(), true)
			.finally(() => { this.resetPending = null; });
		return this.resetPending;
	}
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.paused = true;
		await this.abort();
		await this.task;
		await this.control;
	}
}
