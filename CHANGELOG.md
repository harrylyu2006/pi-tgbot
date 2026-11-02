# Changelog

## Unreleased

### Added

- **Optional `secrets` plugin (off by default).** Enabled by a `secrets` section in `config.json`; without it none of the plugin's code is loaded, no listener is opened, no tools/hooks/commands are registered (the Telegram menu only lists `/secret`, `/secrets`, `/unlock`, `/lock` when the plugin is on) and `kdbxweb` is not needed. `kdbxweb` is an `optionalDependency` (`npm install --omit=optional` skips it); if `secrets.keepass` is configured without it, KeePass switches itself off with a clear log line and the vault keeps working. `scripts/optional-plugin-check.ts` proves this with a module-resolution trace in child processes.
- **Encrypted input and vault.** `/secret NAME` or the `secret_request` tool sends a one-time link as a Telegram button; the value is sealed in the browser to a per-link ephemeral P-256 key (ECDH + HKDF + AES-256-GCM) before it travels over HTTPS, stored with AES-256-GCM under a key kept in a separate file, and never enters the chat transcript, model context or session file. The link message is edited afterwards so the URL leaves the chat history, and the agent is told with a value-free notice that the value arrived.
- `secret_run` (shell with secrets injected as environment variables / 0600 tmpfs files), `{{secret:NAME}}` placeholders in other tools' arguments (substituted after the call is recorded, never in `bash`, `mcpScript`, `write`, `edit` or outbound tools by default), `secret_list`, `secret_delete`, `/secrets`, and an audit log of every use. A per-secret "confirm each use in Telegram" flag can only be set by the operator on the input page.
- Output scrubbing of stored values (raw, URL-encoded, base64, JSON-escaped, per-line for keys) from tool results, the context sent to the model and outbound Telegram text; KeePass values are scrubbed from the moment they are read.
- **Read-only KeePass access (`secrets.keepass`).** Send a `.kdbx` to the bot to install it (signature-checked, atomic, one `.prev` kept, the Telegram message deleted) or let it sync from Google Drive; `/unlock` opens it with the master password typed on a one-time encrypted page and held in memory only (idle auto-lock, hard stop, `/lock`), or from the vault in `stored` mode. Tools `keepass_status`, `keepass_unlock`, `keepass_lock`, `keepass_search` (metadata only, never passwords or notes); entries are used through `secret_run` (`kp:<id>#field`) or `{{secret:kp:<id>#field}}` placeholders, with password, username, URL, TOTP (KeePassXC `otp` incl. the legacy `key=…&step=…` layout, and KeePass 2 `TimeOtp-*` variants), custom fields and text attachments. `pitg-hidden` / `pitg-confirm` tags and `hiddenGroups` / `confirmGroups` control what the agent can see or must ask about; the Recycle Bin is never visible. Argon2 uses Node's built-in `crypto.argon2`.
- **Drive sync (`secrets.keepass.sync`).** At `/unlock` the database is fetched through rclone (read-only scope) — on demand, never in the background, only while locked. The download must match Drive's reported size and sha256 and be a KDBX file; any failure (revoked token, network, moved file, bad download) leaves the local copy untouched and is reported with an actionable one-line reason (rclone's raw output is never echoed). A local copy the operator sent by hand is only replaced by a Drive version modified after that moment. A one-shot `<state dir>/unlock-on-start` marker makes a restart end with the unlock button instead of "now send /unlock".
- `scripts/gdrive-oauth.ts`: optional helper that authorizes a **read-only** Drive remote for rclone on a machine without a browser (loopback flow with manual hand-over, PKCE, state, exact-scope check, careful `rclone.conf` rewrite, never prints the code or tokens).
- **Approval dialogs are generated from the real arguments and shown in full**: the exact command with newlines and indentation, invisible/bidirectional characters made visible (`<U+202E>`…), addresses extracted by the program, advisories for pipe-to-shell / eval / script files / decoding / network transfer, known secret values shown as markers, warnings placed before the command. A command over 950 characters is refused automatically instead of being shown truncated (`TelegramUI.confirmVerbatim` never truncates).
- Anomaly brakes for KeePass: after `maxEntriesPerSession` (default 8) distinct entries in one unlock session every further new entry needs a tap; the first use of each entry/field per session is announced in chat (no tap); `keepass_search` is limited to 30 per 10 minutes and an empty query lists only 15.
- Stability: Argon2 unlock refuses databases above `maxArgonMiB` (default 256) and pre-flights the cgroup's free memory (page cache not counted) so a large key derivation cannot get the whole bot OOM-killed. `systemd/pi-tg.service.d-no-core-dumps.conf.example` (`LimitCORE=0`) keeps decrypted credentials out of core dumps.
- Tests: `npm run test:secrets` — optional-plugin loading, vault/envelope/link server, approval dialogs, Drive OAuth helper, KeePass reader (RFC 6238 vectors; fixtures written by pykeepass and by KeePassXC 2.7.6 whose passwords and TOTP codes are compared with `keepassxc-cli`'s own output; KDBX3/4), Drive sync with a fake rclone, and two real-SDK end-to-end runs against a scripted fake model asserting that no secret value, password, custom field or TOTP code appears in any provider request or in the persisted session file. Fixtures hold fake data only (`scripts/fixtures/README.md` explains how to regenerate them).

### Security

- `.gitignore` and `publication-check` now refuse KeePass databases (`*.kdbx` and their `.prev`/sidecar files) and `vault.json`, except the fake fixtures directly under `scripts/fixtures/`; the publication regression test covers it.
- `@xmldom/xmldom` is pinned to 0.8.15 through `overrides`, clearing the advisories reported for `kdbxweb`'s dependency tree.

### Changed

- `COMMANDS` is split into `CORE_COMMANDS`, `SECRET_COMMANDS` and `KEEPASS_COMMANDS`; the published menu is `commandsFor({ secrets, keepass })`.
- `AgentHost` accepts in-process `extensionFactories`; `redactOutbound` accepts additional redactors; `SendMessageParams` gained `protect_content`.

## 0.1.4

### Added

- Add `/restart` and publish it in the Telegram command menu. Restarting can interrupt an active task; the existing persistent session and model preferences are restored on startup.
- Add staged-publication scanning (`npm run publication-check -- --staged`) that reads Git's indexed blobs, plus offline tests for accidentally staged configuration, dirty working copies and secret-free diagnostics.
- Exclude dependency backups, deployment-only extensions and local live-model probes from publication candidates. Preserve explicit source-file review rather than bulk-staging production directories.

### Changed

- Update Mailparser to 3.12.4 and Nodemailer to 10.2.1, including the vendored extension's declarations. Keep the SDK at 0.84.1 and pi-web-access at 0.18.0; document remaining SDK-chain audit findings rather than claiming a zero-vulnerability release.

### Fixed

- Preserve resumed conversations when official Anthropic 5.5 / Fable 5.1 thinking signatures no longer match the system prompt, tool list or earlier messages. Add the thinking-binding beta and `prefix_mismatch_behavior: "drop_block"` to adaptive requests; leave valid signed blocks unchanged for server-side validation.
- Do not send adaptive-only binding controls with non-adaptive thinking. Omit historical thinking only from those outgoing requests, retaining persisted history, text and tool calls/results. Translate Sonnet 5.5 off-mode to `between_tools`; keep Haiku 5.5's `disabled` behavior.
- Fix transient OpenAI TPM/RPM 429 rate-limit errors being misclassified as non-retryable billing failures due to the trailing `/account/billing` help URL, and default `retry.provider.maxRetries` to 3 (up to 60s `retry-after`).
- Add offline real-SDK restart/streaming regressions with changed AGENTS.md and the same session ID. Scope the compatibility layer to verified models on the official API, leaving other providers and older models untouched.

## 0.1.3

### Changed

- Hide the cache-write row in the Telegram usage panel. Keep cache reads, hit rate, cost, current context and SDK-reported totals unchanged; hidden cache-write tokens can still contribute to the total.
- Add usage-panel regressions for absent, zero and nonzero cache-write statistics.

### Security

- Pin Nodemailer to 9.1.1 and Mailparser to 3.9.20, using the same patched Nodemailer for SMTP and inbound message parsing. Keep the vendored extension's dependency declarations aligned.
- Address Nodemailer advisories GHSA-2x7j-588g-ccc2 (address-parser denial of service), GHSA-wmmp-3585-3rmp and GHSA-cc9r-2j5m-2m83 (recipient-domain validation), and GHSA-8m3c-c648-2xjj (legacy plugin content-resolution access controls).
- Add offline MIME/attachment/threading, Bcc privacy and legacy file/URL access-control regressions. No real mailbox or SMTP credentials are used by these tests.

### Upgrade notes

- Back up configuration, sessions, state and the private delivery outbox before updating dependencies. Install with `npm ci --ignore-scripts`, run `npm test`, and restart only when the active task has finished.
- Pi SDK and pi-web-access remain at 0.84.1 and 0.18.0 respectively; this release does not migrate session data.

## 0.1.2

- Fix inherited Telegram menus when reusing a Bot Token: synchronize operator-chat, all-private-chats and default scopes, including fallback/English/Chinese variants.
- Verify commands after updates instead of logging success for a default list hidden by a higher-priority old menu; replace in place without deleting lists first.
- Add `npm run menu-sync -- /path/to/config.json` for updating command metadata without restarting, polling or creating an agent session.
- Share the command definitions between daemon and maintenance script; add scope-precedence, localization, idempotence and transport regression tests.

## 0.1.1

### Fixed

- Filter user, tool-result and custom message events out of assistant rendering; hide raw provider error payloads.
- Keep session listeners through abort; serialize active reset, model changes and other controls. Handle extension commands/input hooks that complete without starting an agent run.
- Await final Telegram delivery before releasing a task. Serialize terminal writes after in-flight streaming edits and make finish/seal idempotent.
- Confirm only the content revision actually sent; avoid freezing new content at the soft edit limit.
- Retry explicit Telegram 429 responses for all final chunks, with HTML-to-plain-text fallback and observable delivery failure.
- Persist unconfirmed final-answer chunks in a private outbox and add `/retry`; never re-run tools for delivery recovery. Avoid automatic `sendMessage` retries after ambiguous timeouts.
- Split long HTML on tags, entities and Unicode code points, reopening formatting as needed. Fix URL double escaping and protect links from emphasis transformations.
- Correct nested-tag closure and use Telegram-compatible plain thinking quotes/table code blocks.
- Register media-group arrivals before downloads; wait for all registered downloads and preserve message order/captions.
- Reuse nullable-safe panel rendering for `/status`; encode long model IDs as bounded opaque callback references instead of truncating them.
- Suppress both background fetch success and error prompts through a scoped Web extension adapter. Direct Node/systemd startup no longer depends on a prior npm test or writes to node_modules.
- Update outdated probe assertions and add deterministic regressions plus offline SDK lifecycle, mail parsing and UTF-7 checks.

### Dependencies

- mailparser 3.9.16 / html-to-text 10.0.1 / deepmerge-ts 8.0.2.
- Override utf7's semver dependency to 5.7.2.
- Pi SDK remains pinned to 0.84.1; pi-web-access remains pinned to 0.18.0.

### Upgrade notes

Back up configuration, sessions, state and `${statePath}.deliveries.json` before upgrading. Install with `npm ci --ignore-scripts`, run `npm test`, and restart only after the active task finishes. The outbox contains private answer content and must not be published. Telegram provides no idempotency keys: a timeout or crash after server acceptance can still cause a duplicate chunk on explicit `/retry`.
