# Changelog

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
