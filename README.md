# pi-tgbot

A security-conscious, single-operator Telegram interface for the [pi coding agent](https://github.com/badlogic/pi-mono), built directly on `@earendil-works/pi-coding-agent`'s SDK.

It runs one persistent pi session as a headless daemon, receives prompts through Telegram long polling, streams model output by editing a live message, and exposes a small operator panel for status, model selection, thinking level, usage, tools, session reset, and abort.

> [!WARNING]
> This bot can expose powerful coding-agent tools, including shell and filesystem access. A Telegram message may therefore become code execution with the privileges of the service account. Run it on a dedicated host or in a sandbox, use a non-root account, keep the single-user allowlist enabled, and review every extension before loading it.

## Features

- **Single-operator access control** — updates from any Telegram user except `allowedUserId` are dropped before dispatch.
- **Persistent pi session** — resumes the daemon's most recent dedicated session after restart; `/new` starts a clean one.
- **Non-blocking long polling** — Telegram polling continues while a long agent turn runs; later prompts are queued in arrival order.
- **Live streaming** — coalesces model output into one edited Telegram message and respects per-chat rate limits.
- **Reliable final delivery** — long answers are sent as new messages so Telegram generates a notification; oversized output is chunked safely.
- **Telegram-safe Markdown** — compiles streaming Markdown prefixes to balanced Telegram HTML and falls back to plain text on entity errors.
- **Files and stickers** — downloads photos, documents, and stickers into a dated inbox; extracts Lottie text from `.tgs` stickers and optionally uses `ffmpeg` for `.webm` previews.
- **Bounded outbound files** — the model can send artifacts only from configured roots and only to the chat that owns the active turn.
- **Interactive confirmation UI** — extensions can route `confirm` and `select` prompts to Telegram inline buttons; timeouts and delivery failures deny by default.
- **Operational controls** — `/start`, `/status`, `/tokens`, `/new`, `/stop`, model switching, thinking-level switching, and tool visibility.
- **Crash recovery** — remembers seen update IDs, skips stale offline backlogs, and warns when a previous turn was interrupted.
- **Defence in depth** — structured log redaction, outbound secret redaction, tool audit records, dangerous-command confirmation, and remote fan-out guards.
- **Explicit extension loading** — disables ambient extension discovery and loads only the configured extension allowlist.

## Architecture

```text
Telegram Bot API
       │
       ▼
 Poller ── user allowlist / stale-backlog checks
       │
       ▼
 Dispatcher ── one active turn + FIFO queue
       │
       ▼
 AgentHost ── persistent AgentSession from pi SDK
       │              │
       │              ├── explicit extensions
       │              ├── built-in and custom tools
       │              └── dedicated session directory
       ▼
 Event router ── text/tool/lifecycle events
       │
       ▼
 LiveMessage ── redact → Markdown/HTML → throttle/chunk
       │
       ▼
 Telegram chat
```

Important source areas:

- `src/main.ts` — process lifecycle, dispatcher, commands, callbacks, attachments, and shutdown.
- `src/agent/host.ts` — pi SDK resource loading, session creation/resume, model selection, tools, and extensions.
- `src/agent/events.ts` — translates pi session events into live Telegram output and tool audit events.
- `src/telegram/poller.ts` — long polling, allowlist enforcement, conflict recovery, and backoff.
- `src/telegram/live.ts` — streaming edits, throttling, final notification delivery, rendering fallback, and redaction.
- `src/telegram/files.ts` — safe inbound filenames, size limits, retention, and outbound root checks.
- `src/ui/telegram-ui.ts` — inline-button UI adapter for extension confirmations and choices.
- `extensions/` — optional security and fleet fan-out guards.

## Requirements

- Linux is recommended for the supplied systemd unit.
- Node.js **24 or newer**. The daemon executes TypeScript directly using Node's built-in type stripping.
- npm.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Your numeric Telegram user ID.
- At least one model/provider authenticated in pi's agent directory.
- Optional: `ffmpeg` for extracting the first frame from video stickers.

## Install

### 1. Clone and install dependencies

```bash
git clone https://github.com/harrylyu2006/pi-tgbot.git
cd pi-tgbot
npm ci --ignore-scripts
```

`--ignore-scripts` reduces supply-chain exposure. The current dependencies do not require lifecycle scripts for normal operation.

### 2. Prepare a dedicated service account and directories

Running as root is strongly discouraged. One possible layout is:

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-tg --shell /usr/sbin/nologin pi-tg
sudo install -d -o pi-tg -g pi-tg -m 0700 \
  /var/lib/pi-tg/agent \
  /var/lib/pi-tg/sessions \
  /var/lib/pi-tg/inbox \
  /var/log/pi-tg \
  /srv/pi-tg/workspace
sudo install -d -o root -g root -m 0755 /etc/pi-tg
```

Copy the repository to `/opt/pi-tg`, or adjust the supplied unit:

```bash
sudo cp -a . /opt/pi-tg
sudo chown -R root:root /opt/pi-tg
```

The service account needs read access to the application and write access only to the agent, session, inbox, audit, and workspace locations you configure.

### 3. Configure pi authentication

This daemon uses pi's normal provider and model configuration. The `agentDir` in `config.json` must contain the relevant pi files, typically:

```text
/var/lib/pi-tg/agent/
├── auth.json       # provider credentials — private, never commit
├── models.json     # optional custom providers/models — often sensitive
├── settings.json   # default provider/model and pi settings
└── AGENTS.md       # optional global instructions
```

Authenticate with pi as the service user, or securely copy an existing minimal configuration:

```bash
sudo -u pi-tg env HOME=/var/lib/pi-tg pi
# Then run /login inside pi, select a provider, and choose a model.
```

Never put `auth.json`, `models.json`, session JSONL, or your real bot config in this repository.

### 4. Create the Telegram bot config

```bash
sudo cp /opt/pi-tg/config.example.json /etc/pi-tg/config.json
sudo chmod 0600 /etc/pi-tg/config.json
sudo chown pi-tg:pi-tg /etc/pi-tg/config.json
sudoedit /etc/pi-tg/config.json
```

At minimum replace:

- `botToken` — token returned by BotFather.
- `allowedUserId` — the only Telegram user allowed to control the bot.
- `cwd` — the workspace exposed to the coding agent.
- `agentDir` — the service account's pi configuration directory.
- file paths and `outboxRoots` for your deployment.

To discover your numeric user ID, use a trusted Telegram ID bot temporarily or call Telegram's Bot API yourself after messaging your new bot. Do not publish the result together with your bot token.

### 5. Validate before starting

```bash
cd /opt/pi-tg
npm test
sudo -u pi-tg env HOME=/var/lib/pi-tg \
  node src/main.ts /etc/pi-tg/config.json
```

The second command runs in the foreground. Stop it after the bot reaches `ready`, then install the service.

### 6. Install the systemd service

Review `systemd/pi-tg.service` and adjust paths or the service user if needed:

```bash
sudo cp /opt/pi-tg/systemd/pi-tg.service /etc/systemd/system/pi-tg.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-tg
sudo systemctl status pi-tg
journalctl -u pi-tg -f
```

## Configuration reference

The loader rejects unknown keys so typos in safety controls fail loudly.

### Required top-level keys

- `botToken` — Telegram bot token in `<numeric-id>:<secret>` form.
- `allowedUserId` — integer Telegram user ID; every other sender is ignored.

### Runtime paths

- `cwd` — agent working directory. Built-in tools resolve operations here.
- `agentDir` — pi settings, credentials, models, context files, and explicitly referenced resources.
- `sessionDir` — dedicated daemon session directory. It must not be the normal interactive pi session directory.
- `statePath` — durable seen-update and interrupted-turn state. Written atomically with mode `0600`.
- `auditPath` — append-only JSONL tool audit log. Created with mode `0600`.

### Model and extensions

- `model` — optional exact `provider/model-id` override. If omitted, pi's `settings.json` default is used.
- `extensions` — explicit extension paths or `npm:` specifiers. Ambient extension discovery is disabled.
- `tools.deny` — tool names to exclude.
- `tools.extraActive` — registered tools to activate in addition to pi's defaults.

Do not load another Telegram polling extension with the same token. `AgentHost` refuses known `pi-telegram` extensions because two `getUpdates` consumers cause Telegram 409 conflicts.

### Streaming renderer

- `render.editThrottleMs` — minimum time between edits to one Telegram message; must be at least 1000 ms.
- `render.maxChars` — target payload size; must remain below Telegram's 4096-character limit.
- `render.maxEditsPerTurn` — soft cap for status-only live edits; new answer/thinking content may still edit after the cap so long turns do not appear frozen.
- `render.notifyAfterMs` — turns longer than this send the final answer as new messages to trigger a notification.

### Turn and backlog controls

- `turn.idleTimeoutMs` — abort a running pi session only after this long with no incoming request and no agent progress event. Every accepted Telegram update or SDK event renews the window; it is not a fixed total-runtime cap.
- `coldStart.staleSeconds` — on startup, acknowledge and skip older queued messages rather than executing a possibly dangerous backlog.

### Files

- `files.inboxDir` — dated directories for downloaded Telegram files.
- `files.outboxRoots` — only files beneath these roots can be sent with `telegram_send_file`. Keep this narrow; do not use `/` or an entire home directory.
- `files.maxDownloadMb` — reject inbound files over this size before downloading where metadata permits.
- `files.maxUploadMb` — reject outbound files over this size.
- `files.retentionDays` — remove old dated inbox directories at startup.

## Telegram commands and panel

- `/start`, `/help`, `/panel` — open the operator panel.
- `/status` — polling state, model, thinking level, context usage, and busy state.
- `/tokens`, `/usage` — cumulative token/cache/cost statistics and current context usage.
- `/new` — dispose the current session and start a fresh dedicated session.
- `/stop` — abort the running agent turn.

The panel also provides inline model selection, thinking-level selection, active-tool inspection, new-session confirmation, and abort.

## Custom tools

The daemon registers two Telegram-specific tools:

### `telegram_send_file`

Sends a local artifact to the operator's current Telegram chat. The model cannot choose a destination chat. Files must be regular files beneath `files.outboxRoots` and under the upload size limit.

### `telegram_ask`

Shows 2–8 choices as Telegram inline buttons and returns the selected label inside the same agent turn. It times out after 10 minutes and instructs the model not to guess when no answer arrives.

## Security model

This project is designed as defence in depth, not as a sandbox.

### Access boundary

- Only one numeric Telegram user ID is accepted.
- Unknown senders are skipped while the polling offset still advances, preventing an outsider's message from wedging the bot.
- Callback buttons are fenced by process boot ID and session generation so stale panels cannot mutate a new session.

### Secret handling

- Real `config.json`, backups, credentials, model catalogs, sessions, logs, and inbox files are ignored by Git.
- Structured logs redact fields whose names contain `token`, `key`, `secret`, `password`, or `authorization`, plus Telegram-token-shaped text.
- Prompt and model content are not written to journald; only IDs, lengths, state, and timing are logged.
- Model output is scrubbed before Telegram delivery for common API keys, bot tokens, JWTs, private keys, credentialed database URLs, and credential assignments.
- Tool audit arguments are redacted and capped; tool results are not copied into the audit log.
- `npm run publication-check` scans publishable files for forbidden filenames and common credential patterns.

Redaction is necessarily heuristic. It can miss unusual secrets and can occasionally redact harmless text. Do not rely on it as the only control.

### Tool controls

The optional `extensions/security.ts`:

- asks before recursive deletion, `sudo`, raw-device writes, destructive Git commands, and similar operations;
- blocks writes to environment files, credential files, SSH keys, `.git`, and `node_modules`;
- fails closed when a confirmation UI is unavailable.

The optional `extensions/fanout-guard.ts` asks before multi-host SSH/Ansible/fleet operations and remote state-changing commands. Its purpose is to limit prompt-injection blast radius, not to prove a command safe.

### Deployment recommendations

1. Run as a dedicated unprivileged user or inside a VM/container.
2. Point `cwd` at a dedicated workspace rather than a whole home directory.
3. Keep `outboxRoots` as narrow as possible.
4. Deny tools you do not need, especially `bash`, `write`, and `edit` for read-only deployments.
5. Load only reviewed extensions and pin dependency versions.
6. Protect `/etc/pi-tg/config.json`, the pi agent directory, sessions, inbox, state, and audit files with mode `0600`/`0700`.
7. Treat Telegram, your LLM provider, installed extensions, shell commands, and fetched web content as separate trust boundaries.
8. Back up credentials and sessions before upgrades, but never commit those backups.

## Tests

```bash
npm test
```

The test command runs:

- TypeScript type checking.
- Streaming Markdown/HTML safety checks over every prefix of an adversarial document.
- Outbound redaction fixtures, including false-positive checks.
- Fail-closed Telegram UI confirmation tests.
- Fleet fan-out guard fixtures.
- Publication secret and forbidden-file checks.

An optional live SDK probe creates an isolated pi session and performs a real model request:

```bash
npm run probe
```

The probe requires valid provider credentials and may incur provider usage. Override its paths when necessary:

```bash
PI_TG_PROBE_CWD=/srv/pi-tg/workspace \
PI_TG_PROBE_AGENT_DIR=/var/lib/pi-tg/agent \
npm run probe
```

## Operations

Useful commands:

```bash
systemctl status pi-tg
journalctl -u pi-tg -f
systemctl restart pi-tg
```

Telegram API behavior handled by the daemon:

- A revoked/invalid bot token is terminal and exits with status 78; the sample unit does not restart that status.
- Telegram 409 conflict means another webhook or long-poll consumer owns the token. The daemon enters a degraded state and retries with jitter.
- A configured webhook is deleted during preflight because this project uses long polling.
- Telegram 429 responses honor `retry_after`.
- Stalled non-cosmetic API calls get one retry on a fresh connection.

`check-pi-update.sh` is an optional notification script. It reads the same private config and can be scheduled by cron or a systemd timer:

```bash
PI_TG_CONFIG=/etc/pi-tg/config.json /opt/pi-tg/check-pi-update.sh
```

## Privacy before publishing or forking

Before pushing your own fork:

```bash
npm run publication-check
git status --short
git diff --cached --check
```

Verify that the commit contains `config.example.json`, not `config.json`, and does not contain:

- Telegram bot tokens or user/chat IDs from your deployment;
- pi `auth.json` or custom `models.json` credentials;
- session transcripts (`*.jsonl`);
- downloaded Telegram files;
- state, audit, or application logs;
- private infrastructure names, IP addresses, domains, usernames, or absolute personal paths;
- backup files containing older credentials.

If a real secret ever enters Git history, deleting it in a later commit is not enough. Revoke/rotate it and rewrite the history before publishing.

## Known limitations

- Single Telegram operator and one long-lived agent session by design.
- Long polling only; startup removes any configured webhook.
- Voice messages are not transcribed.
- Photos are saved as file paths rather than injected as SDK image blocks. A text-only model needs a compatible vision skill/tool to inspect them.
- Video sticker previews require `ffmpeg`; otherwise the raw `.webm` path is passed to the model.
- This is not a security sandbox. The model receives the service account's actual tool privileges.
- Safety and redaction rules are pattern based and cannot cover every command or credential format.
- The implementation targets the pinned pi SDK version in `package.json`; run the probe and tests before upgrading.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Keep changes small and preserve these invariants:

- polling must never wait for an agent turn;
- only `agent_settled` releases the dispatcher;
- stale session events must be generation fenced;
- Telegram HTML must be structurally closed for every streaming prefix;
- confirmation failures must deny;
- real configuration and runtime artifacts must never be committed.

## License

[MIT](LICENSE)

## Acknowledgements

Built on the pi coding-agent SDK and Telegram Bot API. This project is an independent integration and is not affiliated with Telegram.
