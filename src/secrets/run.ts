/** Run a shell command with secrets injected as environment variables / temp files. */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables that change how the shell or dynamic linker behaves; a secret has no business in them. */
const FORBIDDEN_ENV = /^(?:PATH|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|HOME|SHELL|NODE_OPTIONS|LD_.*|DYLD_.*)$/;

export function checkEnvName(name: string): string | null {
	if (!ENV_NAME_RE.test(name)) return `invalid environment variable name: ${name}`;
	if (FORBIDDEN_ENV.test(name)) return `environment variable ${name} is reserved`;
	return null;
}

export interface RunInput {
	command: string;
	cwd: string;
	env: Record<string, string>;
	/** ENV_NAME → secret value, written to a 0600 file whose path becomes the variable's value. */
	files: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Applied to the raw capture before truncation so a secret can never be cut in half and slip through. */
	scrub: (text: string) => string;
	/** Fleet gateway supplies this trusted cgroup; the shell joins before executing user code. */
	workerCgroup?: string;
}

export interface RunOutput {
	text: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	truncated: boolean;
}

const CAPTURE_CAP = 2 * 1024 * 1024;
const TAIL_BYTES = 50 * 1024;
const TAIL_LINES = 2000;

export async function runWithSecrets(input: RunInput): Promise<RunOutput> {
	let dir: string | null = null;
	const env: Record<string, string> = { ...(process.env as Record<string, string>), ...input.env };
	try {
		if (Object.keys(input.files).length) {
			dir = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "pi-tg-secret-"));
			chmodSync(dir, 0o700);
			let i = 0;
			for (const [envName, value] of Object.entries(input.files)) {
				const p = join(dir, `s${i++}`);
				// OpenSSH refuses a key without a trailing newline.
				writeFileSync(p, value.endsWith("\n") || !value.includes("\n") ? value : `${value}\n`, { mode: 0o600 });
				env[envName] = p;
			}
		}
		return await new Promise<RunOutput>((resolve) => {
			if (input.workerCgroup) {
				env.PI_TG_WORKER_CGROUP = input.workerCgroup;
				env.PI_TG_WORKER_COMMAND = input.command;
			}
			const command = input.workerCgroup
				? 'printf "%s" "$$" > "$PI_TG_WORKER_CGROUP/cgroup.procs" || exit 125; exec /bin/bash -c "$PI_TG_WORKER_COMMAND"'
				: input.command;
			const child = spawn("/bin/bash", ["-c", command], { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
			let buf = Buffer.alloc(0);
			let truncatedCapture = false;
			let timedOut = false, aborted = false, settled = false;
			const onData = (d: Buffer): void => {
				buf = Buffer.concat([buf, d]);
				if (buf.length > CAPTURE_CAP) { buf = buf.subarray(buf.length - CAPTURE_CAP); truncatedCapture = true; }
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			const killTree = (): void => {
				try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
				setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref();
			};
			const timer = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);
			const onAbort = (): void => { aborted = true; killTree(); };
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (input.signal?.aborted) onAbort();
			const finish = (exitCode: number | null, signal: string | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				let text = input.scrub(buf.toString("utf8"));
				let truncated = truncatedCapture;
				const lines = text.split("\n");
				if (lines.length > TAIL_LINES) { text = lines.slice(-TAIL_LINES).join("\n"); truncated = true; }
				if (Buffer.byteLength(text) > TAIL_BYTES) { text = Buffer.from(text).subarray(-TAIL_BYTES).toString("utf8"); truncated = true; }
				resolve({ text, exitCode, signal, timedOut, aborted, truncated });
			};
			child.on("error", (err) => { buf = Buffer.from(String(err.message)); finish(null, null); });
			child.on("close", (code, sig) => finish(code, sig));
		});
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}
