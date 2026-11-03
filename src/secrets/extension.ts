/**
 * Agent-facing half of the vault.
 *
 * The invariant: a secret's value is never part of any tool call or tool result
 * the model sees, and never part of the persisted transcript.
 *
 *  - secret_request   asks the operator to type a value on a one-time page.
 *  - secret_run       runs a shell command with secrets injected as env vars /
 *                     temp files; output is scrubbed before the model sees it.
 *  - {{secret:NAME}}  placeholders in other tools' arguments are swapped for the
 *                     value inside the harness, *after* the call was recorded
 *                     (pi hands tool_call a clone of the arguments, so the stored
 *                     assistant message keeps the placeholder).
 *  - tool_result / context hooks scrub any known value that still shows up
 *                     (an error page echoing a password, a file the user pasted).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { redactOutbound } from "../telegram/redact.ts";
import { checkEnvName, runWithSecrets } from "./run.ts";
import { SecretsService } from "./service.ts";
import { KeepassError } from "./keepass-core.ts";
import { NAME_RE } from "./vault.ts";

/** `{{secret:NAME}}` for the vault, `{{secret:kp:ID}}` / `{{secret:kp:ID#field}}` for a KeePass entry. */
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9][A-Za-z0-9._-]{0,63}|kp:[0-9a-f]{8,32}(?:#[^{}]{1,80})?)\}\}/g;

/** Never substituted, whatever the config says: shells (use secret_run) and code-bearing tools. */
const ALWAYS_DENY = new Set(["bash", "mcpScript", "secret_run", "secret_request", "secret_list", "secret_delete"]);

const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
/** pi marks a tool result as an error only when `execute` throws. */
function fail(message: string): never { throw new Error(message); }

function placeholdersIn(value: unknown, out: Set<string>, depth = 0): void {
	if (depth > 12) return;
	if (typeof value === "string") { for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1]!); return; }
	if (Array.isArray(value)) { for (const v of value) placeholdersIn(v, out, depth + 1); return; }
	if (value && typeof value === "object") for (const v of Object.values(value)) placeholdersIn(v, out, depth + 1);
}

/** In-place substitution; the caller owns `value` (it is the harness's private clone). */
function substitute(value: unknown, resolve: (name: string) => string | undefined, depth = 0): unknown {
	if (depth > 12) return value;
	if (typeof value === "string") {
		// Some gateways take their arguments as a JSON *string*; substitute inside the parsed form so a quote or
		// backslash in the secret cannot break the document.
		if (/^\s*[[{]/.test(value) && value.includes("{{secret:")) {
			try { return JSON.stringify(substitute(JSON.parse(value), resolve, depth + 1)); } catch { /* not JSON after all */ }
		}
		return value.replace(PLACEHOLDER, (whole, name: string) => resolve(name) ?? whole);
	}
	if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = substitute(value[i], resolve, depth + 1); return value; }
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		for (const k of Object.keys(o)) o[k] = substitute(o[k], resolve, depth + 1);
		return o;
	}
	return value;
}

function summarize(command: string): string {
	return redactOutbound(command).text.replace(/\s+/g, " ").slice(0, 120);
}

export function createSecretsExtension(svc: SecretsService): (pi: ExtensionAPI) => void {
	const denied = new Set([...ALWAYS_DENY, ...svc.config.denyPlaceholderTools]);

	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "secret_request",
			label: "Ask operator for a secret",
			description:
				"Ask the operator to enter a password / token / API key / SSH key / cookie on a one-time encrypted web page. " +
				"A button with the link is sent to Telegram; the value goes browser → harness and is never shown to you or written to the chat. " +
				"Returns only whether it was stored. Afterwards use it with secret_run (shell) or a {{secret:NAME}} placeholder (other tools).",
			promptSnippet: "secret_request — have the operator enter a credential on a one-time encrypted page (value never reaches you)",
			promptGuidelines: [
				"Never ask the operator to type or paste a password, token, API key, private key or cookie into the Telegram chat. Call secret_request instead; they enter it on a one-time encrypted page and you only learn that it was stored.",
				"Check secret_list before asking: if the credential is already stored, just use it — the operator has pre-authorised that, do not ask again.",
				"Use a stored secret with secret_run (shell: map env vars or temp files to secret names, e.g. sshpass -e / curl -H \"Authorization: Bearer $TOKEN\") or by writing {{secret:NAME}} in the arguments of other tools such as a browser MCP tool. Never put placeholders in bash, write or edit.",
				"Never try to read back, print, echo, re-encode, split or otherwise extract a secret's value, and never send one anywhere the operator did not ask for. If the operator pasted a credential into the chat anyway, tell them to re-enter it via secret_request and consider rotating it.",
			],
			parameters: Type.Object({
				name: Type.String({ pattern: NAME_RE.source, description: "Short id, e.g. vps-main-root, github-token. Letters, digits, . _ -" }),
				description: Type.Optional(Type.String({ maxLength: 200, description: "What it is for; shown to the operator on the page and in /secrets." })),
				wait: Type.Optional(Type.Boolean({ description: "Wait for the operator to submit (default true, up to the link TTL). With false, returns right after sending the link." })),
			}),
			async execute(id, params, signal) {
				const res = await svc.request({
					name: params.name, description: (params.description ?? "").trim(), chatId: svc.operatorChat(),
					wait: params.wait !== false, signal, origin: `agent:${id}`,
				});
				switch (res.kind) {
					case "saved": return text(`Stored secret "${params.name}" (${res.meta.length} characters${res.meta.confirm ? ", operator requires confirmation on each use" : ""}). Use it via secret_run env/files or a {{secret:${params.name}}} placeholder.`);
					case "pending": return text(`Link sent to the operator; waiting is disabled. Check secret_list later for "${params.name}".`);
					case "expired": return fail("The operator did not enter the value before the link expired. Nothing was stored. Say what you need and offer to request again.");
					case "cancelled": return fail("The request was cancelled. Nothing was stored.");
					default: return fail(res.message);
				}
			},
		});

		pi.registerTool({
			name: "secret_list",
			label: "List stored secrets",
			description: "List the names, descriptions and usage of secrets in the vault. Never returns values.",
			promptSnippet: "secret_list — names/descriptions of stored credentials (no values)",
			parameters: Type.Object({}),
			async execute() {
				const list = svc.vault.list();
				const kp = svc.keepass ? `\nKeePass: ${svc.keepass.unlocked ? `unlocked (${svc.keepass.entryCount} entries visible)` : "locked"}${svc.keepass.fileInfo().exists ? "" : ", no database file provided yet"}. Use keepass_search / keepass_unlock.` : "";
				if (!list.length) return text(`The vault is empty.${kp}`);
				return text(kp.trim() + (kp ? "\n" : "") + list.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""} (${s.length} chars, used ${s.uses}x${s.confirm ? ", confirm-each-use" : ""})`).join("\n"));
			},
		});

		pi.registerTool({
			name: "secret_delete",
			label: "Delete a stored secret",
			description: "Delete a secret from the vault. The operator is asked to confirm in Telegram first.",
			promptSnippet: "secret_delete — remove a stored credential (asks the operator)",
			parameters: Type.Object({ name: Type.String({ pattern: NAME_RE.source }) }),
			async execute(id, params) {
				if (!svc.vault.has(params.name)) return fail(`No such secret: ${params.name}`);
				if (!(await svc.confirmDelete(params.name))) return fail("The operator did not approve deleting it. Do not retry.");
				svc.vault.delete(params.name);
				svc.audit({ event: "delete", name: params.name, origin: `agent:${id}` });
				return text(`Deleted secret "${params.name}".`);
			},
		});

		pi.registerTool({
			name: "secret_run",
			label: "Run a command with secrets",
			description:
				"Run a shell command (bash -c) with stored secrets injected as environment variables (env) or as 0600 temp files whose path is put in the variable (files, for SSH keys/cookie jars). " +
				"Output is scrubbed of the secret values before you see it. stdin is empty. Example: {command: \"sshpass -e ssh -o StrictHostKeyChecking=accept-new root@203.0.113.7 uptime\", env: {SSHPASS: \"vps-main-root\"}}. " +
				"Do not put secret values or {{secret:…}} placeholders in the command itself; reference them as $VARNAME.",
			promptSnippet: "secret_run — run a shell command with stored credentials injected as $ENV / temp files (output scrubbed)",
			parameters: Type.Object({
				command: Type.String({ minLength: 1, maxLength: 20000 }),
				env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "ENV_VAR → vault secret name, or a KeePass reference kp:<id>[#field] (field: password (default), username, totp, a custom field, or attachment:<name>)" })),
				files: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "ENV_VAR → secret name or kp:<id>#field; the variable holds the path of a temp file containing the value (SSH keys, cookie jars)" })),
				timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: "Default 120" })),
				cwd: Type.Optional(Type.String()),
			}),
			async execute(id, params, signal, _onUpdate, ctx) {
				const env = params.env ?? {}, files = params.files ?? {};
				const mapping = [...Object.entries(env), ...Object.entries(files)];
				if (mapping.length === 0) return fail("secret_run needs at least one entry in env or files; for plain commands use bash.");
				if (mapping.length > 8) return fail("At most 8 secrets per call.");
				const seen = new Set<string>();
				for (const [envName, secretName] of mapping) {
					const bad = checkEnvName(envName);
					if (bad) return fail(bad);
					if (seen.has(envName)) return fail(`${envName} is mapped twice.`);
					seen.add(envName);
				}
				if (mapping.some(([, ref]) => SecretsService.isKeepassRef(ref))) {
					const unavailable = await svc.ensureKeepass(params.command);
					if (unavailable) return fail(unavailable);
				}
				for (const [, ref] of mapping) {
					const problem = svc.refProblem(ref);
					if (problem) return fail(problem);
				}
				const found = new Set<string>(); placeholdersIn(params.command, found);
				if (found.size) return fail("Do not put {{secret:…}} placeholders in the command; map the secret to an env var and use $VARNAME.");

				const blocked = await svc.gate(mapping.map(([, s]) => s), { tool: "secret_run", text: params.command });
				if (blocked) return fail(blocked);

				const envVals: Record<string, string> = {}, fileVals: Record<string, string> = {};
				try {
					for (const [e, s] of Object.entries(env)) envVals[e] = svc.getRef(s);
					for (const [e, s] of Object.entries(files)) fileVals[e] = svc.getRef(s);
				} catch (err) {
					if (err instanceof KeepassError) return fail(err.message);
					throw err;
				}
				svc.audit({ event: "use", tool: "secret_run", names: mapping.map(([, s]) => s), labels: mapping.map(([, s]) => svc.labelRef(s)), cmd: summarize(params.command), cmdSha: createHash("sha256").update(params.command).digest("hex").slice(0, 16), call: id });
				svc.recordUse(mapping.map(([, s]) => s), { tool: "secret_run", text: params.command });

				const out = await runWithSecrets({
					command: params.command, cwd: params.cwd ?? ctx.cwd, env: envVals, files: fileVals,
					timeoutMs: (params.timeout_seconds ?? 120) * 1000, signal, scrub: svc.scrubText,
					workerCgroup: (ctx as unknown as { fleetWorkerCgroup?: string }).fleetWorkerCgroup,
				});
				const tail = [
					out.timedOut ? `[timed out after ${params.timeout_seconds ?? 120}s]` : "",
					out.aborted ? "[aborted]" : "",
					out.truncated ? "[output truncated to the last part]" : "",
					out.signal ? `[killed by ${out.signal}]` : `[exit code ${out.exitCode}]`,
				].filter(Boolean).join(" ");
				const bad = out.exitCode !== 0 || out.timedOut || out.aborted;
				const body = `${out.text}${out.text && !out.text.endsWith("\n") ? "\n" : ""}${tail}`;
				return bad ? fail(body) : text(body, { exitCode: out.exitCode });
			},
		});

		// ---- KeePass ---------------------------------------------------------------
		const kp = svc.keepass;
		if (kp) {
			const fmtEntry = (e: { id: string; title: string; group: string; username: string; url: string; tags: string[]; hasTotp: boolean; confirm: boolean; extra: string[] }): string =>
				`- id=${e.id} | ${e.group ? `${e.group}/` : ""}${e.title}${e.username ? ` | user: ${e.username}` : ""}${e.url ? ` | url: ${e.url}` : ""}${e.tags.length ? ` | tags: ${e.tags.join(",")}` : ""}${e.hasTotp ? " | totp" : ""}${e.extra.length ? ` | extra: ${e.extra.join(", ")}` : ""}${e.confirm ? " | operator confirms each use" : ""}`;
			const kpFail = (err: unknown): never => { if (err instanceof KeepassError) return fail(err.message); throw err; };

			pi.registerTool({
				name: "keepass_status",
				label: "KeePass status",
				description: "Show whether the operator's KeePass database is locked, how many entries are visible, and when it auto-locks. Never returns entry contents.",
				promptSnippet: "keepass_status — is the KeePass database locked/unlocked",
				parameters: Type.Object({}),
				async execute() {
					const st = kp.status();
					const file = st.file.exists ? `database file: ${(st.file.bytes / 1024).toFixed(1)} KB, ${kp.meta()?.source === "drive" ? "synced from Drive" : "sent by the operator"}, updated ${new Date(st.file.mtimeMs).toISOString().slice(0, 16).replace("T", " ")} UTC${kp.cfg.sync ? "; it is re-checked against Drive on each unlock" : ""}` : "no database file available yet";
					return text(`KeePass ${st.unlocked ? `UNLOCKED: ${st.entries} entries visible; locks after ${Math.ceil(st.idleLeftSec / 60)} more idle minutes (hard stop in ${(st.maxLeftSec / 3600).toFixed(1)} h)` : "LOCKED"}; mode=${st.mode}; ${file}.`, st);
				},
			});

			pi.registerTool({
				name: "keepass_unlock",
				label: "Unlock KeePass",
				description:
					"Ask the operator to unlock their KeePass database. They get a button in Telegram that opens a one-time encrypted page where they type the master password; it is held in memory only and never shown to you. " +
					"Returns once unlocked (or expired/cancelled). If it is already unlocked this says so. Never ask for the master password in chat.",
				promptSnippet: "keepass_unlock — have the operator unlock KeePass on a one-time encrypted page",
				promptGuidelines: [
					"The operator's passwords mostly live in a KeePass database. To log in somewhere: keepass_status → (keepass_unlock if locked) → keepass_search for the site/account → use the entry's id with secret_run (env: {VAR: \"kp:<id>#password\"}) or a {{secret:kp:<id>#password}} placeholder in another tool's arguments. keepass_search never returns passwords, and neither does anything else.",
					"For a login that needs a one-time code, use the entry's #totp field the same way, immediately before submitting it (codes expire in seconds). SSH keys stored as attachments are #attachment:<filename> via the files map.",
					"Never ask the operator for the KeePass master password or any entry's password in chat, never try to read or decrypt the KeePass file or the vault files yourself, and do not search for secrets you were not asked to use. If keepass_search finds nothing, say so instead of guessing.",
				],
				parameters: Type.Object({
					wait: Type.Optional(Type.Boolean({ description: "Wait for the operator (default true, up to the link TTL)." })),
					reason: Type.Optional(Type.String({ maxLength: 120, description: "Shown to the operator: what you need KeePass for." })),
				}),
				async execute(id, params, signal) {
					const res = await svc.requestUnlock({ chatId: svc.operatorChat(), wait: params.wait !== false, signal, origin: `agent:${id}`, description: (params.reason ?? "").trim() });
					switch (res.kind) {
						case "unlocked": return text(`KeePass is unlocked (${res.detail}). Use keepass_search to find entries.`);
						case "already-unlocked": return text(`KeePass is already unlocked (${kp.entryCount} entries visible).`);
						case "pending": return text("Unlock link sent to the operator; waiting is disabled. Call keepass_status later.");
						case "expired": return fail("The operator did not unlock KeePass before the link expired. Say what you need and offer to try again.");
						case "cancelled": return fail("The unlock request was cancelled (or too many wrong passwords). KeePass is still locked.");
						default: return fail(res.message);
					}
				},
			});

			pi.registerTool({
				name: "keepass_lock",
				label: "Lock KeePass",
				description: "Lock the KeePass database now (drops the decrypted entries from memory). Use when you are finished with it.",
				promptSnippet: "keepass_lock — lock KeePass when done",
				parameters: Type.Object({}),
				async execute() { return text(kp.lock("manual") ? "KeePass locked." : "KeePass was already locked."); },
			});

			pi.registerTool({
				name: "keepass_search",
				label: "Search KeePass",
				description:
					"Search the unlocked KeePass database by words in the title, username, URL, group or tag (all words must match). Returns id, title, group, username, URL, tags and which extra fields exist — never passwords, notes or other secret values. " +
					"Use the id in secret_run env/files (\"kp:<id>#password\") or a {{secret:kp:<id>#password}} placeholder. Locked database → call keepass_unlock.",
				promptSnippet: "keepass_search — find KeePass entries (titles/usernames/URLs only, no passwords)",
				parameters: Type.Object({
					query: Type.String({ maxLength: 120, description: "Words to match, e.g. \"github\" or \"staging root\". Empty lists entries (use limit)." }),
					group: Type.Optional(Type.String({ maxLength: 120, description: "Only entries in this group path (and below)." })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default 15." })),
				}),
				async execute(id, params) {
					const unavailable = await svc.ensureKeepass(`keepass_search ${params.query.slice(0, 60)}`);
					if (unavailable) return fail(unavailable);
					if (!svc.allowSearch()) return fail("Too many KeePass searches in a short time (limit: 30 per 10 minutes). Use the entries you already found, or tell the operator what you are looking for.");
					try {
						const { total, results } = kp.search(params.query, { group: params.group, limit: params.limit });
						svc.audit({ event: "keepass-search", q: params.query.slice(0, 80), matches: total, call: id });
						if (!results.length) return text("No matching entries. (Entries tagged hidden, in hidden groups or in the Recycle Bin are not visible to you.)", { total });
						return text(`${total} match${total === 1 ? "" : "es"}${total > results.length ? `, showing ${results.length}` : ""}:\n${results.map(fmtEntry).join("\n")}`, { total });
					} catch (err) { return kpFail(err); }
				},
			});
		}

		// ---- hooks ----------------------------------------------------------------

		pi.on("tool_call", async (event) => {
			// The secret_* tools take names, not values, and secret_run vets its own command.
			if (event.toolName.startsWith("secret_")) return;
			const found = new Set<string>();
			placeholdersIn(event.input, found);
			// Unknown vault names pass through untouched so documentation that mentions the syntax is not mangled.
			// KeePass references are unmistakable, so an unusable one is an error, not a literal to type into a login form.
			const kpRefs = [...found].filter((n) => SecretsService.isKeepassRef(n));
			const known = [...found.keys()].filter((n) => !SecretsService.isKeepassRef(n) && svc.vault.has(n));
			if (!known.length && !kpRefs.length) return;
			if (denied.has(event.toolName)) {
				const hint = event.toolName === "bash" || event.toolName === "secret_run" || event.toolName === "mcpScript"
					? "Shell/code tools never get placeholders substituted. Use secret_run with env mapping (secret → $VARNAME) instead."
					: `Placeholders are not allowed in ${event.toolName} (it sends data off-box or writes it to disk). Use secret_run if you need the value in a command.`;
				return { block: true, reason: `{{secret:…}} refused in ${event.toolName}. ${hint}` };
			}
			if (kpRefs.length) {
				const unavailable = await svc.ensureKeepass(JSON.stringify(event.input));
				if (unavailable) return { block: true, reason: unavailable };
				for (const ref of kpRefs) { const problem = svc.refProblem(ref); if (problem) return { block: true, reason: problem }; }
			}
			const refs = [...known, ...kpRefs];
			const blocked = await svc.gate(refs, { tool: event.toolName, text: JSON.stringify(event.input) });
			if (blocked) return { block: true, reason: blocked };
			try { substitute(event.input, (name) => (svc.hasRef(name) ? svc.getRef(name) : undefined)); }
			catch (err) { if (err instanceof KeepassError) return { block: true, reason: err.message }; throw err; }
			svc.audit({ event: "use", tool: event.toolName, names: refs, labels: refs.map((r) => svc.labelRef(r)), call: event.toolCallId });
			svc.recordUse(refs, { tool: event.toolName, text: JSON.stringify(event.input) });
		});

		pi.on("tool_result", async (event) => {
			if (!svc.scrubber.active) return;
			const content = svc.scrubber.scrubDeep(event.content);
			const details = svc.scrubber.scrubDeep(event.details);
			if (content === event.content && details === event.details) return;
			return { content, details };
		});

		pi.on("context", async (event) => {
			if (!svc.scrubber.active) return;
			let changed = false;
			const messages = event.messages.map((m: any) => {
				// Thinking blocks carry provider signatures; never touch them.
				if (m.role === "assistant" && Array.isArray(m.content)) {
					const content = m.content.map((b: any) => {
						if (b?.type === "text") { const t = svc.scrubber.scrub(b.text); return t === b.text ? b : { ...b, text: t }; }
						if (b?.type === "toolCall") { const a = svc.scrubber.scrubDeep(b.arguments); return a === b.arguments ? b : { ...b, arguments: a }; }
						return b;
					});
					if (content.some((b: unknown, i: number) => b !== m.content[i])) { changed = true; return { ...m, content }; }
					return m;
				}
				if (m.role === "user" || m.role === "toolResult") {
					if (typeof m.content === "string") { const t = svc.scrubber.scrub(m.content); if (t !== m.content) { changed = true; return { ...m, content: t }; } return m; }
					const content = svc.scrubber.scrubDeep(m.content);
					if (content !== m.content) { changed = true; return { ...m, content }; }
				}
				return m;
			});
			return changed ? { messages } : undefined;
		});
	};
}
