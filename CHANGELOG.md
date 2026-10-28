# Changelog

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
