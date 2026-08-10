/**
 * Pre-M1 empirical probe.
 *
 * The design plan derived its SDK call sequence by reading .d.ts files. Four of
 * those inferences were never actually executed. This script executes them, in
 * dependency order, and prints exactly what happened. Nothing here is part of
 * the daemon — it exists so that M1 is written against observed behavior rather
 * than against a plausible reading of the type declarations.
 *
 * Run:  npm run probe
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const CWD = process.env.PI_TG_PROBE_CWD ?? process.cwd();
const AGENT_DIR = process.env.PI_TG_PROBE_AGENT_DIR ?? `${process.env.HOME ?? CWD}/.pi/agent`;

let failures = 0;

function head(n: number, title: string): void {
	console.log(`\n${"=".repeat(72)}\n[${n}] ${title}\n${"=".repeat(72)}`);
}
function ok(msg: string): void {
	console.log(`  ✓ ${msg}`);
}
function bad(msg: string): void {
	failures++;
	console.log(`  ✗ ${msg}`);
}
function info(msg: string): void {
	console.log(`    ${msg}`);
}

// ---------------------------------------------------------------------------
head(0, "module resolution + typebox identity (plan §7 item 3)");
// ---------------------------------------------------------------------------
const require_ = createRequire(import.meta.url);
let typeboxPaths: string[] = [];
try {
	const mine = require_.resolve("typebox");
	typeboxPaths.push(mine);
	info(`our typebox      : ${mine}`);
	const piPkg = require_.resolve("@earendil-works/pi-coding-agent/package.json");
	info(`pi package.json  : ${piPkg}`);
	const piRequire = createRequire(piPkg);
	const theirs = piRequire.resolve("typebox");
	info(`pi's typebox     : ${theirs}`);
	if (mine === theirs) {
		ok("single deduped typebox copy — defineTool() schemas will share one TSchema brand");
	} else {
		typeboxPaths.push(theirs);
		bad("TWO typebox copies resolved — customTools may fail to typecheck; fall back to a cast");
	}
} catch (err) {
	bad(`typebox resolution failed: ${String(err)}`);
}

// ---------------------------------------------------------------------------
head(1, "what the package actually exports");
// ---------------------------------------------------------------------------
const pi = await import("@earendil-works/pi-coding-agent");
const wanted = [
	"createAgentSession",
	"DefaultResourceLoader",
	"SessionManager",
	"SettingsManager",
	"defineTool",
	"AuthStorage",
	"ModelRegistry",
	"getAgentDir",
];
for (const name of wanted) {
	if (name in pi) ok(`export present: ${name}`);
	else bad(`export MISSING: ${name}`);
}
info(`(total exports: ${Object.keys(pi).length})`);

// ---------------------------------------------------------------------------
head(2, "resource loader: noExtensions + npm: specifier (plan §7 item 1)");
// ---------------------------------------------------------------------------
const { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } = pi as any;

const settingsManager = SettingsManager.create(CWD, AGENT_DIR);
ok("SettingsManager.create(cwd, agentDir) returned");
try {
	info(`defaultProvider=${settingsManager.getDefaultProvider?.()} defaultModel=${settingsManager.getDefaultModel?.()}`);
} catch (err) {
	info(`(settings getters threw: ${String(err)})`);
}

let loader: any = null;
for (const spec of ["npm:pi-web-access"]) {
	console.log(`\n  -- trying additionalExtensionPaths: ${JSON.stringify(spec)}`);
	try {
		const l = new DefaultResourceLoader({
			cwd: CWD,
			agentDir: AGENT_DIR,
			settingsManager,
			noExtensions: true,
			additionalExtensionPaths: [spec],
		});
		await l.reload();
		const res = l.getExtensions();
		const paths = (res.extensions ?? []).map((e: any) => e.resolvedPath ?? e.path);
		const errs = res.errors ?? [];
		info(`loaded ${paths.length} extension(s): ${JSON.stringify(paths)}`);
		if (errs.length) info(`errors: ${JSON.stringify(errs).slice(0, 500)}`);
		const gotWeb = paths.some((p: string) => /pi-web-access/.test(String(p)));
		const gotTelegram = paths.some((p: string) => /pi-telegram/.test(String(p)));
		if (gotWeb) {
			ok(`pi-web-access loaded via ${spec}`);
			if (gotTelegram) bad("@llblab/pi-telegram ALSO loaded — it would fight us for the bot token");
			else ok("@llblab/pi-telegram correctly NOT loaded");
			loader = l;
			break;
		}
		bad(`pi-web-access not among loaded extensions for ${spec}`);
	} catch (err) {
		bad(`loader failed for ${spec}: ${String(err).slice(0, 300)}`);
	}
}
if (!loader) {
	bad("no working extension spec found — continuing with a bare loader so later probes still run");
	loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, settingsManager, noExtensions: true });
	await loader.reload();
}

// ---------------------------------------------------------------------------
head(3, "session creation against an isolated session dir (plan §7 item 4 / Q2)");
// ---------------------------------------------------------------------------
const probeSessionDir = mkdtempSync(join(tmpdir(), "pi-tg-probe-"));
info(`isolated session dir: ${probeSessionDir}`);

const sessionManager = SessionManager.create(CWD, probeSessionDir);
ok("SessionManager.create(cwd, sessionDir) returned");
try {
	info(`getSessionFile() -> ${sessionManager.getSessionFile?.()}`);
} catch (err) {
	info(`(getSessionFile threw: ${String(err)})`);
}

const created = await createAgentSession({
	cwd: CWD,
	agentDir: AGENT_DIR,
	resourceLoader: loader,
	sessionManager,
	excludeTools: [],
});
const session = created.session;
ok("createAgentSession() returned");
if (created.modelFallbackMessage) info(`modelFallbackMessage: ${created.modelFallbackMessage}`);
try {
	info(`model: ${session.model?.provider}/${session.model?.id}`);
	info(`supportsThinking(): ${session.supportsThinking?.()}`);
	info(`thinkingLevels: ${JSON.stringify(session.getAvailableThinkingLevels?.())}`);
	info(`isIdle=${session.isIdle} pendingMessageCount=${session.pendingMessageCount} isCompacting=${session.isCompacting}`);
} catch (err) {
	info(`(session getters threw: ${String(err)})`);
}

// ---------------------------------------------------------------------------
head(4, "subscribe -> bindExtensions -> tool registration (plan §7 items 2, 8)");
// ---------------------------------------------------------------------------
const seen: string[] = [];
const toolEvents: string[] = [];
const unsubscribe = session.subscribe((event: any) => {
	seen.push(event.type);
	if (event.type === "tool_execution_start") toolEvents.push(`start:${event.toolName ?? event.tool ?? "?"}`);
	if (event.type === "tool_execution_end") toolEvents.push(`end:${event.toolName ?? event.tool ?? "?"}`);
});
ok("session.subscribe() returned an unsubscribe fn");

const before = session.getAllTools().map((t: any) => t.name);
info(`tools BEFORE bindExtensions: ${JSON.stringify(before)}`);
info(`active BEFORE: ${JSON.stringify(session.getActiveToolNames())}`);

try {
	await session.bindExtensions({
		abortHandler: () => {},
		onError: (err: unknown) => info(`ext onError: ${String(err).slice(0, 200)}`),
	});
	ok("bindExtensions() resolved headless (no uiContext)");
} catch (err) {
	bad(`bindExtensions() threw: ${String(err).slice(0, 400)}`);
}

const after = session.getAllTools().map((t: any) => t.name);
const active = session.getActiveToolNames();
info(`tools AFTER : ${JSON.stringify(after)}`);
info(`active AFTER: ${JSON.stringify(active)}`);
const newTools = after.filter((n: string) => !before.includes(n));
if (newTools.length) ok(`bindExtensions registered new tools: ${JSON.stringify(newTools)}`);
else bad("bindExtensions registered NO new tools — pi-web-access tools will be missing");
for (const t of ["web_search", "fetch_content"]) {
	if (after.includes(t)) {
		if (active.includes(t)) ok(`${t}: registered AND active`);
		else bad(`${t}: registered but NOT active — M1 tool sweep must activate it explicitly`);
	} else bad(`${t}: not registered at all`);
}
const sample = session.getAllTools()[0];
info(`ToolInfo shape: ${JSON.stringify(Object.keys(sample ?? {}))}`);

// ---------------------------------------------------------------------------
head(5, "one real end-to-end turn (auth + event stream shape)");
// ---------------------------------------------------------------------------
const t0 = Date.now();
let settled = false;
const settledPromise = new Promise<void>((resolve) => {
	const un = session.subscribe((event: any) => {
		if (event.type === "agent_settled") {
			settled = true;
			un();
			resolve();
		}
	});
	setTimeout(() => resolve(), 180_000).unref?.();
});

try {
	await session.prompt("Reply with exactly: OK. Do not use any tools.");
	ok("prompt() resolved without throwing");
} catch (err) {
	bad(`prompt() threw: ${String(err).slice(0, 400)}`);
}
await settledPromise;
info(`agent_settled observed: ${settled} (${Date.now() - t0}ms)`);

const counts: Record<string, number> = {};
for (const t of seen) counts[t] = (counts[t] ?? 0) + 1;
info(`event types observed: ${JSON.stringify(counts, null, 0)}`);
if (seen.includes("message_update")) ok("message_update events present (streaming path works)");
else bad("NO message_update events — streaming render has no source");
if (seen.includes("agent_settled")) ok("agent_settled present (terminal signal works)");
else bad("NO agent_settled — the dispatcher would never release");

try {
	const usage = session.getContextUsage?.();
	info(`getContextUsage(): ${JSON.stringify(usage)}`);
	const stats = session.getSessionStats?.();
	info(`getSessionStats(): ${JSON.stringify(stats)}`);
} catch (err) {
	info(`(usage/stats threw: ${String(err)})`);
}

// ---------------------------------------------------------------------------
head(6, "teardown");
// ---------------------------------------------------------------------------
try {
	unsubscribe();
	session.dispose?.();
	ok("unsubscribe() + dispose() clean");
} catch (err) {
	bad(`teardown threw: ${String(err)}`);
}
try {
	rmSync(probeSessionDir, { recursive: true, force: true });
	ok(`probe session dir removed: ${probeSessionDir}`);
} catch {}

console.log(`\n${"=".repeat(72)}`);
console.log(failures === 0 ? "ALL PROBES PASSED" : `${failures} PROBE FAILURE(S) — fix the plan before writing M1`);
console.log(`${"=".repeat(72)}\n`);
process.exit(failures === 0 ? 0 : 1);
