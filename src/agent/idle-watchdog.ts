/**
 * Sliding inactivity watchdog for one agent turn.
 *
 * Unlike a fixed wall-clock deadline, every accepted operator request or agent
 * progress event calls `touch()`. A long-running turn may therefore continue as
 * long as it is alive; only a completely silent interval reaches the timeout.
 */
export class IdleWatchdog {
	private readonly timeoutMs: number;
	private readonly onTimeout: () => void;
	private timer: NodeJS.Timeout | null = null;
	private generation = 0;

	constructor(timeoutMs: number, onTimeout: () => void) {
		this.timeoutMs = timeoutMs;
		this.onTimeout = onTimeout;
	}

	/** Start or renew the full inactivity window. */
	touch(): void {
		this.stopTimer();
		const generation = ++this.generation;
		this.timer = setTimeout(() => {
			if (generation !== this.generation) return;
			this.timer = null;
			this.onTimeout();
		}, this.timeoutMs);
		this.timer.unref?.();
	}

	/** Cancel the watchdog. A stale callback cannot affect a later turn. */
	stop(): void {
		this.generation++;
		this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
}
