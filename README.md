# pi-tgbot

把 [pi coding agent](https://github.com/badlogic/pi-mono) 搬进 Telegram 的单用户机器人。

它基于 `@earendil-works/pi-coding-agent` SDK，长期运行一个独立、可恢复的 pi 会话。你可以直接在 Telegram 中发任务、查看模型输出、观察当前工具调用和运行状态，并通过按钮切换模型、调整思考等级、中断任务或创建新会话。

这个项目的重点是：**让 pi 在 Telegram 中真正可用，而且长任务的运行过程足够直观。** 它不是一个以“安全拦截”为主要功能的项目，也不是沙箱。

## 未发布：可选插件（加密输入、保险库、KeePass）

- 新增默认关闭的 `secrets` 插件：一次性加密输入页、AES-256-GCM 保险库、`secret_run` 与 `{{secret:名称}}` 占位符、输出擦除，以及只读的 KeePass 接入（可选 Drive 同步）。没配置时不加载任何插件代码，`kdbxweb` 是可选依赖。详见「可选插件」与 CHANGELOG。

## v0.1.4 会话兼容、重启命令与发布隐私检查

- 修复官方 Anthropic 模型恢复旧会话时，因系统提示词、工具清单或早期消息变化导致的 thinking 签名 400。adaptive 模式使用官方 `drop_block` 策略，不通过清空聊天来规避问题。
- 修复 Sonnet 5.5 的关闭思考参数，并为 Haiku 5.5 保留对应的独立行为；增加同一会话重启、流式正文和用量统计回归测试。
- 修复 OpenAI TPM/RPM 429 限流报错因末尾附带 `/account/billing` 帮助链接而被 `pi-ai` 误判为不可重试账单错误的问题，并默认开启 provider HTTP 层 `retry-after` 限流重试（最多 3 次、单次上限 60s）。
- 新增 `/restart` 命令并同步 Telegram 菜单。此命令会中断正在运行的任务；会话恢复仍使用已有的持久化机制。
- 邮件运行时更新为 Nodemailer **10.2.1** / Mailparser **3.12.4**，根项目和 vendored 扩展声明保持一致。
- 发布扫描新增 `--staged`，检查 Git 暂存区实际内容而不是未提交的工作副本；忽略依赖备份和本地部署资料，并补充隐私检查回归测试。

pi SDK 仍固定为 **0.84.1**，`pi-web-access` 仍为 **0.18.0**。本版不是 SDK 大版本升级，也不宣称依赖已零漏洞，见下方「已知依赖风险」。完整历史见 [CHANGELOG.md](CHANGELOG.md)。

## v0.1.3 用量界面与邮件依赖修复

用量面板不再显示「缓存写入」一行，保留缓存读取、命中率、费用和当前上下文。合计仍使用 SDK 的完整统计，因此可能包含未单列的缓存写入量。

当时的邮件依赖固定为 Nodemailer 9.1.1 / Mailparser 3.9.20（v0.1.4 已更新），修复已披露的地址解析、收件域名校验和旧式插件内容读取权限问题。新增离线邮件格式、附件、回复线程、密送隐私和文件/URL 访问限制回归测试，不连接真实邮箱、不发送真实邮件。

## v0.1.2 菜单迁移修复

Telegram 私聊菜单优先使用当前 chat 和 `all_private_chats` 作用域，最后才回落到 default。复用旧 Bot Token 时，只更新默认命令并不能替换旧机器人的私聊菜单。本版在启动时同步并核验这三个作用域的默认、英文和中文命令列表，不再先删后建。

不重启服务、不创建会话、不启动第二个轮询器，也可以单独同步：

```bash
npm run menu-sync -- /etc/pi-tg/config.json
```

其他语言的旧 chat 专属命令未自动枚举（Telegram API 不提供全部语言列表），需按该语言单独检查；默认 chat 菜单会覆盖其他较低作用域。

## v0.1.1 可靠性修复

本版修复运行中 `/new`、无模型扩展命令导致的忙碌卡死、工具结果误渲染、旧流式编辑覆盖最终答案、长回答部分丢失、相册下载竞态、HTML 分段与链接编码等问题。完整变更见 [CHANGELOG.md](CHANGELOG.md)。

最终回答会先写入私有交付队列，再逐段发送；明确的 429 会按 `retry_after` 重试。网络故障后可用 `/retry` 只重发未确认分段，不会重新运行模型或工具。Telegram 不支持消息幂等键，因此超时/进程崩溃边界仍可能出现重复分段，不能承诺 exactly-once。

## 主要功能

- **Telegram 实时输出**：模型生成正文时持续编辑同一条消息，不必等整轮任务结束；SDK 发出的用户消息事件不会被误当成助手正文，因此不会在“思考中”下方重复显示本轮 Prompt。
- **实时运行状态**：显示思考、准备调用工具、工具名称、参数摘要、执行进度、重试和上下文压缩等状态。
- **可见思考内容**：当模型 API 返回可展示的 thinking/reasoning 内容时，会在独立的可折叠引用块中实时显示；如果 provider 返回的思考内容本身以本轮 Prompt 的原文开头，只移除这段开头复述，后续思考照常显示；被 provider 标记为 redacted 的内容不会展示。
- **长任务不会“假死”**：普通状态更新达到软上限后可以降频，但新的思考内容和正文仍会继续更新。
- **可恢复的最终送达**：较长任务完成后另发新消息触发通知；超长回答按标签、转义实体和 Unicode 字符安全分段。未确认分段保留在私有 outbox，`/retry` 可恢复；发送结束前不释放当前任务。
- **持久会话**：服务重启后恢复最近的专用会话；模型和思考等级也会保留。
- **运行中可追加指令**：Agent 执行期间仍继续接收 Telegram 消息；新消息通过 Pi steering 注入当前运行，在当前 assistant turn（含已开始的工具调用）结束后的下一个模型边界读取，而不是等整轮任务结束再排成独立任务。
- **操作面板**：查看状态、Token 用量、上下文占用、当前工具，切换模型和思考等级，创建新会话、中断任务或一键重启服务。
- **模型 reasoning 兼容**：针对多种模型家族补充真实可用的思考档位和请求格式，避免面板展示 endpoint 实际不支持的等级。官方 Anthropic 5.5 / Fable 5.1 的 adaptive 请求启用 thinking binding `drop_block`：重启、AGENTS.md 或工具列表改变后，由服务端仅丢弃前缀不匹配的旧思考块，不因签名绑定而整轮 400。非 adaptive 请求仅在出站副本中移除旧思考块；Sonnet 5.5 的 off 模式使用 `between_tools`，Haiku 5.5 保持 `disabled`。不修改持久聊天记录，不影响第三方兼容端点或其他模型。
- **内置 Web、视觉与邮件能力**：固定依赖并自动加载 `pi-web-access`（提供网页搜索、正文抓取、来源核查、PDF、GitHub 仓库和视频处理）与本地 vendored `pi-email` 扩展（IMAP/SMTP 邮件读取、搜索、发送、回复、转发、移动、删除和标记）；内置 `image-describe` skill（多模态模型原生识图，纯文本模型支持 OpenRouter 视觉降级兜底）。
- **文件与贴纸**：接收照片、文档和 Telegram 贴纸；可把生成的本地文件发回当前对话。
- **扩展 UI**：pi 扩展的 `confirm`、`select` 等交互可以映射为 Telegram 内联按钮。
- **可选插件（默认关闭）**：加密输入页与保险库、KeePass 只读接入（可选从 Google Drive 同步）。让 Agent 在不看到密码、不让密码进聊天记录的前提下替你登录；见「可选插件」一节。
- **单用户私聊模式**：只有 `allowedUserId` 指定的 Telegram 用户可以在与 Bot 的私聊中操作；即使操作者本人在群里发消息也会被拒绝，避免结果暴露给群成员。

## ⚠️ 使用前务必理解：数据安全与中转站风险

这个项目会把一个拥有工具权限的 Coding Agent 暴露到 Telegram。它可能读取文件、执行 Shell、访问网络，也可能把工具结果继续发送给模型。请不要把它当成普通聊天机器人。

### 慎重使用模型中转站

如果 `baseUrl` 指向第三方中转站、API 聚合站或反向代理，那么中转站在技术上可能接触到你发给模型的内容，包括：

- Telegram 中输入的任务和上下文；
- pi 会话历史及压缩摘要；
- 模型可见的系统提示词；
- 工具调用参数和工具执行结果；
- 代码、配置文件、日志片段及终端输出；
- 上传给模型分析的文本或图片；
- API 返回的 thinking/reasoning 内容。

**当前版本不会在工具结果进入模型前做统一脱敏。** 这是有意的：很多运维任务要求模型读取真实配置或凭证才能完成。但这也意味着，一旦 Agent 通过 `read`、`bash` 等工具读到了密码、Token、私钥或数据库连接串，这些内容就有可能随下一次模型请求发送给 provider 或中转站。

Telegram 出站消息仍有启发式密钥脱敏，但它只保护“模型输出 → Telegram”这一段，**不能阻止数据被发送给模型服务，也不能替代对中转站的信任判断**。

建议按以下优先级选择模型接入方式：

1. 优先使用官方 API、官方 OAuth/订阅渠道或自己控制的网关；
2. 如必须使用中转站，只选择身份、隐私政策、日志策略和运营记录都可核实的服务；
3. 确认全程 HTTPS，并了解中转站是否保存请求正文、响应、Header、IP 和账户标识；
4. 不要把长期有效的主密钥、钱包助记词、Telegram 2FA、SSH 私钥等交给 Agent；
5. 给 API Key、数据库账户和云凭证设置最小权限、额度限制与独立用途；
6. 定期轮换凭证；怀疑泄露时应立即吊销，而不是只删除聊天记录；
7. 高敏感任务使用隔离机器、隔离工作目录和专门的低权限账号。

### Telegram 也不是密码保险箱

Bot 对话经过 Telegram Bot API，不是 Secret Chat。不要在聊天中直接发送长期密码、私钥、恢复码或其他不可撤销的敏感信息；需要让 Agent 使用凭据时，请用下文的「加密输入与保险库」。实时展示的工具参数、思考内容和最终回答也会留在 Telegram 聊天记录中。

### Web 搜索同样会向外部服务发送数据

`pi-web-access` 可能把搜索词、目标 URL 或页面内容发送给选定的搜索、抓取或总结服务。涉及内部域名、私有文档和一次性签名 URL 时，不要直接交给公共搜索或远程抓取 provider。

## 工作方式

```text
Telegram Bot API
        │
        ▼
 Poller ── 用户白名单 / 冷启动旧消息处理
        │
        ▼
 Dispatcher ── 当前任务 + 运行中 steering（竞态时 FIFO 兜底）
        │
        ▼
 AgentHost ── pi SDK 的持久 AgentSession
        │              │
        │              ├── 内置 pi-web-access
        │              ├── 本地 vendored pi-email
        │              ├── 内置 image-describe skill
        │              ├── 显式配置的扩展
        │              ├── 内置与自定义工具
        │              └── 独立 session 目录
        ▼
 Event Router ── 角色过滤 / 正文 / 思考 / 工具 / 生命周期事件
        │
        ▼
 LiveMessage ── 脱敏 → Markdown/HTML → 限速/分段
        │
        ▼
 Telegram 对话
```

主要源码：

- `src/main.ts`：进程生命周期、命令、回调、附件和退出流程。
- `src/agent/dispatcher.ts`：任务/交付状态机、运行中 steering、串行化 reset/模型切换。
- `src/telegram/delivery.ts`：持久交付队列、429 重试、HTML 降级和 `/retry`。
- `src/telegram/media-groups.ts`：按消息到达登记相册，等待下载全部完成并保持消息顺序。
- `src/agent/web-access.mjs`：Web 扩展适配器，抑制后台成功/失败通知进入模型上下文。
- `src/agent/host.ts`：pi SDK 初始化、会话恢复、模型/思考等级和扩展加载。
- `src/agent/events.ts`：过滤事件角色，并把 pi 事件流转换成 Telegram 中可见的正文、思考和工具状态。
- `src/agent/reasoning.ts`：模型家族的思考档位与 provider 请求兼容。
- `src/agent/anthropic-thinking.ts`：官方 Anthropic 思考签名前缀绑定与 Sonnet 5.5 off-mode 请求兼容。
- `src/agent/audit.ts`：记录不含原始参数和结果的工具审计元数据。
- `src/agent/outbox.ts`：检查出站文件真实路径、允许根目录和符号链接。
- `src/telegram/poller.ts`：Telegram 长轮询、私聊/用户限制、冲突恢复和退避。
- `src/telegram/live.ts`：实时消息编辑、限速、Prompt 复述过滤、思考块、最终通知和分段。
- `src/telegram/markdown.ts`、`html.ts`：把流式 Markdown 编译成 Telegram 可接受的闭合 HTML。
- `src/telegram/files.ts`：附件下载、文件名处理和保留期限。
- `src/ui/panel.ts`：Telegram 操作面板。
- `src/ui/telegram-ui.ts`：把扩展交互映射为 Telegram 按钮。

## 环境要求

- 推荐 Linux；仓库附带 systemd service。
- Node.js **24 或更高版本**，直接使用 Node 内置 TypeScript type stripping 运行源码。
- npm。
- 从 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot Token。
- 你的 Telegram 数字用户 ID。
- 至少一个已在 pi agent 目录中完成认证的模型/provider。
- 可选：为 `pi-web-access` 配置搜索 provider；没有 Key 时可使用其零配置 Exa fallback。
- 可选：通过 `email_setup` 配置 IMAP/SMTP 邮箱，凭证保存在服务账号的 `~/.pi/email-config.json`。
- 可选：安装 `ffmpeg`，用于视频贴纸预览以及部分网页/视频能力。

## 安装

### 1. 克隆并安装依赖

```bash
git clone https://github.com/harrylyu2006/pi-tgbot.git
cd pi-tgbot
npm ci --ignore-scripts
```

`pi-web-access` 与邮件依赖已固定在 `package.json` 中；`pi-web-access` 和本地 `vendor/pi-email` 都由程序自动加载，不需要另外执行 `pi install`。`pi-email` 的源码和补丁随仓库发布，不依赖每次启动时从 npm 临时安装。`--ignore-scripts` 可减少依赖安装阶段执行生命周期脚本的风险；当前正常运行不依赖这些脚本。

### 2. 建议创建独立服务账号

不建议直接以 root 运行。示例目录：

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-tg --shell /usr/sbin/nologin pi-tg
sudo install -d -o pi-tg -g pi-tg -m 0700 \
  /var/lib/pi-tg/agent \
  /var/lib/pi-tg/sessions \
  /var/lib/pi-tg/inbox \
  /var/log/pi-tg \
  /srv/pi-tg/workspace
sudo install -d -o root -g root -m 0755 /etc/pi-tg

sudo cp -a . /opt/pi-tg
sudo chown -R root:root /opt/pi-tg
```

建议让服务账号只对 agent、session、inbox、audit 和工作目录拥有必要写权限。

### 3. 配置 pi 模型认证

`config.json` 中的 `agentDir` 使用 pi 的标准配置，通常包括：

```text
/var/lib/pi-tg/agent/
├── auth.json       # provider 凭证，禁止提交
├── models.json     # 可选自定义 provider/model，通常也很敏感
├── settings.json   # 默认模型与 pi 设置
└── AGENTS.md       # 可选的全局指令
```

可以用服务账号启动一次 pi 完成 `/login`：

```bash
sudo -u pi-tg env HOME=/var/lib/pi-tg pi
```

如果使用自定义 provider 或中转站，请先阅读上面的“数据安全与中转站风险”。

### 4. 创建 Bot 配置

```bash
sudo cp /opt/pi-tg/config.example.json /etc/pi-tg/config.json
sudo chmod 0600 /etc/pi-tg/config.json
sudo chown pi-tg:pi-tg /etc/pi-tg/config.json
sudoedit /etc/pi-tg/config.json
```

至少需要修改：

- `botToken`：BotFather 返回的 Token；
- `allowedUserId`：唯一允许操作机器人的 Telegram 用户 ID；
- `cwd`：Agent 的工作目录；
- `agentDir`：pi 配置与认证目录；
- `sessionDir`、`statePath`、`auditPath` 和文件目录；
- `files.outboxRoots`：允许 Bot 发回 Telegram 的本地目录。

不要把真实 `config.json`、`auth.json`、`models.json` 或 `web-search.json` 放进仓库。

### 5. 配置 Web Access（可选）

`pi-web-access` 通常从服务账号 HOME 下的配置读取 provider 信息：

```text
/var/lib/pi-tg/.pi/web-search.json
```

也可以不配置 Key，使用可用的零配置 fallback。具体 provider 和字段以 `pi-web-access` 文档为准。请不要把搜索 API Key 写进公开的 `config.example.json`。

### 6. 启动前验证

```bash
cd /opt/pi-tg
npm test

sudo -u pi-tg env HOME=/var/lib/pi-tg \
  node src/main.ts /etc/pi-tg/config.json
```

看到 `ready` 后可先停止前台进程，再安装 systemd 服务。

### 7. 安装 systemd 服务

检查 `systemd/pi-tg.service` 中的用户、目录和 Node 路径，然后执行：

```bash
sudo cp /opt/pi-tg/systemd/pi-tg.service /etc/systemd/system/pi-tg.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-tg
sudo systemctl status pi-tg
journalctl -u pi-tg -f
```

## 配置说明

程序会拒绝未知配置字段，避免拼写错误被静默忽略；配置文件不能对组用户或其他用户开放读取，路径项必须使用绝对路径，数值项也会检查合理范围。完整示例见 `config.example.json`。

### 必填项

- `botToken`：格式为 `<数字ID>:<secret>` 的 Telegram Bot Token。
- `allowedUserId`：唯一允许访问机器人的 Telegram 数字用户 ID。

### 路径与状态

- `cwd`：Agent 工作目录；内置文件和 Shell 工具默认在这里执行。
- `agentDir`：pi 的设置、认证、模型、技能和上下文目录。
- `sessionDir`：本 Bot 专用会话目录，不能与交互式 pi 的默认 session 目录混用。
- `statePath`：保存已见 update、上次任务中断状态、模型和思考等级。
- `${statePath}.deliveries.json`：自动创建的私有交付队列（0600），保存尚未完整确认送达的回答。备份时一并保留，不要提交到 Git 或公开发布。队列损坏会阻止启动而非静默丢弃；请先备份后排查。
- `auditPath`：追加写入的工具审计日志；只记录工具名、时间、参数字节数和参数摘要哈希，不保存原始参数或工具结果。

### 实时消息

- `render.editThrottleMs`：同一消息两次编辑之间的最小间隔，不得低于 1000ms。
- `render.maxChars`：单条实时消息的目标长度，需要低于 Telegram 的 4096 字符限制。
- `render.maxEditsPerTurn`：普通状态更新的软上限；新的思考或正文仍可继续更新。
- `render.notifyAfterMs`：任务超过该时长后，结束时另发新消息以触发通知。

### 任务与运行中消息

- 普通新消息在 Agent 忙碌时使用 Pi `steer()` 注入当前 run。它不会强杀正在执行的工具，而是在当前 assistant turn 和工具调用完成后的下一次模型请求中生效。
- 只有消息恰好撞上 run 结束的竞态窗口时，才进入本地 FIFO，作为紧接着的下一条任务执行。
- `turn.idleTimeoutMs`：只有连续这么久没有请求或 Agent 进度事件才会中断任务，不是整轮任务的固定时限。
- `coldStart.staleSeconds`：服务启动时，早于该时间的积压消息会被确认并跳过，避免重启后突然执行旧任务。

### 可选插件

`secrets`（加密输入页与保险库）和 `secrets.keepass`（KeePass 只读接入，含 `sync` 的 Drive 同步）整段可省略，省略即关闭，详见「可选插件」一节。`config.example.json` 里给出了完整示例。

### 工具与扩展

- `tools.deny`：需要停用的工具名，例如只读部署可禁用 `bash`、`write`、`edit`。
- `tools.extraActive`：额外启用的已注册工具。
- `extensions`：额外加载的本地路径或 `npm:` specifier。环境中的扩展不会被自动扫描。
- 内置 `pi-web-access` 通过受版本控制的适配器加载；不再在启动或测试时修改 `node_modules`。`npm start`、直接 Node、systemd 共用该路径，适用于 root-owned 只读代码目录。若在 `extensions` 里重复填写，会自动去重。
- 内置 `image-describe` skill 随项目打包加载，多模态模型使用原生 `read` 识图，纯文本模型（如 DeepSeek、GLM）支持通过 OpenRouter 进行视觉兜底。

### 文件

- `files.inboxDir`：Telegram 下载文件保存位置，按日期建立子目录。
- `files.outboxRoots`：`telegram_send_file` 允许读取的根目录。必须是非空绝对路径；程序拒绝 `/`，并在发送前解析真实路径、拒绝符号链接。不要配置整个 HOME。
- `files.maxDownloadMb`：入站文件大小上限。
- `files.maxUploadMb`：发回 Telegram 的文件大小上限。
- `files.retentionDays`：启动时清理多少天以前的收件目录。

## Telegram 命令与面板

- `/start`、`/help`、`/panel`：打开操作面板；
- `/status`：打开状态视图，查看模型、思考等级、上下文和运行状态；
- `/tokens`、`/usage`：查看累计 Token、缓存、成本和上下文占用；
- `/new`：丢弃当前上下文，创建一个新的专用会话；
- `/stop`：中断当前 Agent 任务；
- `/restart`：一键重启 `pi-tg` 服务（会话与模型选择会保留）；
- `/retry`：仅重发 outbox 中未确认送达的回答分段，不重新运行任务；需等待当前任务结束；
- `/secret 名称`、`/secrets`、`/secret del 名称`：加密输入与保险库；
- `/unlock`、`/lock`：解锁/锁定 KeePass。

后两组命令属于「可选插件」，只有配置了 `secrets`（以及 `secrets.keepass`）才会出现在命令菜单里；没启用时即使手动输入，也只会得到一句「功能未启用」。

面板还支持：

- 切换模型；
- 切换当前模型真实支持的思考等级；
- 查看启用和未启用工具；
- 确认创建新会话；
- 中断当前任务；
- 一键重启 `pi-tg`。

模型与思考等级的成功选择会写入状态文件，服务重启或 `/new` 后仍会恢复。

## Telegram 专用工具

### `telegram_send_file`

把本地生成的文件发送给当前任务所属的 Telegram 对话。模型不能自行指定其他 chat ID；文件必须位于 `files.outboxRoots` 下且不超过上传限制。

### `telegram_ask`

把 2–8 个选项显示成 Telegram 内联按钮，并把用户选择返回同一轮 Agent。超时或按钮发送失败时返回无选择，不让模型自行猜测。

## 可选插件：加密输入、保险库与 KeePass（`secrets`）

这是**默认关闭的可选插件**，由 `config.json` 里的 `secrets` 段整体开关，由下面几层组成，每一层都可以单独不启用：

| 功能 | 开关 | 额外依赖 | 默认 |
|---|---|---|---|
| 加密输入页 + 保险库 + `secret_request` / `secret_run` / `{{secret:名称}}` | `secrets` | 一个对外的 HTTPS 反向代理 | 关闭 |
| KeePass 只读接入（`/unlock`、`keepass_*` 工具） | `secrets.keepass` | 可选依赖 `kdbxweb`（纯 JS） | 关闭 |
| 从 Google Drive 同步 KeePass 库 | `secrets.keepass.sync` | `rclone` | 关闭 |
| 无浏览器机器上的 Drive 只读授权助手 | `scripts/gdrive-oauth.ts` | `rclone` | 手动运行 |

**没配置 `secrets` 时的保证**（`node scripts/optional-plugin-check.ts` 逐条验证）：插件代码一行都不会被加载；不开监听端口；不注册 `secret_*`/`keepass_*` 工具与上下文钩子；Telegram 命令菜单里没有 `/secret`、`/secrets`、`/unlock`、`/lock`；不需要 `kdbxweb`。只配 `secrets` 不配 `secrets.keepass` 时也不会加载 `kdbxweb`。`kdbxweb` 放在 `optionalDependencies` 里：`npm install` 默认会装，不用 KeePass 的人可以 `npm install --omit=optional` 跳过；万一配置了 KeePass 却没装它，KeePass 会自己关掉并在日志里说明原因，保险库和输入页不受影响。

**最小启用方式**：

```json
"secrets": { "baseUrl": "https://vault.example.com", "listenPort": 18620 }
```

再按下面「部署」一节给它配一个 TLS 反向代理，重启即可；要 KeePass 就再加 `"keepass": {}`。**关闭**：删掉 `secrets` 段并重启（保险库文件和密钥文件留在原处，不会被删除）。

### 加密输入与保险库

目标：密码、Token、API Key、SSH 私钥、Cookie 不经过 Telegram 聊天记录、不进入模型上下文，但 Agent 又能在**不逐次打扰你**的前提下用它们去登录。

#### 流程

1. Agent 需要凭据时调用 `secret_request`（或你自己发 `/secret 名称`）。Bot 发来一条带 **「🔐 打开安全输入页」按钮** 的消息；链接只在按钮里，不在消息文字里，消息设置为禁转发。
2. 你在网页里输入。浏览器用**本链接专属的一次性 P-256 公钥**（ECDH + HKDF + AES-256-GCM）先加密，再通过 HTTPS 发出；服务端私钥只存在进程内存，用完即丢。这样即使有人记录了 nginx/代理的请求体，也只能看到密文。
3. 保存成功后，那条 Telegram 消息被编辑成「✅ 已安全保存」并清空按钮（URL 从聊天记录里消失），**同时 Agent 会立刻收到一条「[系统通知]」**：只含名称、字符数、是否覆盖/需确认，不含值。Agent 正在跑任务时通知会并入当前任务，否则自动开一轮；如果它在等这个凭据就接着干，没有待办就只确认「已收到」并问你要做什么。Agent 自己 `secret_request`（默认等待）发起的请求不重复通知，它已经从工具结果里得知。
4. Agent 只会知道「已保存」。之后用 `secret_run`（shell 命令，值以环境变量/0600 临时文件注入）或在其他工具参数里写 `{{secret:名称}}` 占位符（浏览器 MCP 输入框等）。占位符在 harness 内、调用记录之后才替换成真值：对话与会话文件里永远只有占位符。
5. 所有工具结果、发往模型的上下文、发往 Telegram 的文字都会被扫描；已知的值（含 URL 编码、base64、JSON 转义、私钥逐行）一律替换为 `[SECRET:名称]`。

#### 链接本身的保护

256 位随机 token、**只能用一次**、默认 10 分钟过期；GET/HEAD 不消耗（防 Telegram 链接预览或爬虫）；页面只能写不能读；Host/Origin 固定、CSP 带 nonce 且禁外联、无 Cookie、请求体大小限制、按 IP 限流、未知路径统一 404；解密连续失败 5 次后链接作废。页面上还可以勾选「每次使用前都在 Telegram 里确认」：该密钥每次被 `secret_run` 或占位符使用都会先弹出允许/拒绝按钮（超时即拒绝）。**这个开关只能由你在网页里勾，模型无法设置。**

#### 部署

本机只监听回环地址（`secrets.listenHost` 只允许回环），需要一个 TLS 反向代理对外：

```nginx
server {
    listen 443 ssl;
    server_name vault.example.com;
    # ssl_certificate ...
    access_log off;                      # URL 里有一次性 token
    client_max_body_size 256k;
    location ^~ /s/ {
        proxy_pass http://127.0.0.1:18620;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location / { return 404; }
}
```

`config.json`：

```json
"secrets": { "baseUrl": "https://vault.example.com", "listenPort": 18620 }
```

可选项：`dir`（默认 `/var/lib/pi-tg/vault`）、`keyPath`（默认 `/etc/pi-tg/vault.key`，与密文**分开存放**）、`linkTtlSeconds`（60–1800，默认 600）、`denyPlaceholderTools`（默认拒绝在 `write`/`edit`/邮件/搜索/抓取/生图等会外发或落盘的工具里替换占位符）。`bash`、`mcpScript` 永远不替换占位符，请用 `secret_run`。

#### 工具

- `secret_request`：向你索取一个凭据（只返回「已保存」）；
- `secret_list`：名称、用途、使用次数（不含值）；
- `secret_run`：带凭据执行 shell 命令，输出擦除后返回；例：`sshpass -e ssh root@host uptime` + `env: {SSHPASS: "vps-root"}`；
- `secret_delete`：删除（需你在 Telegram 确认）；
- `keepass_status` / `keepass_unlock` / `keepass_lock` / `keepass_search`：见下面的 KeePass 小节。

### KeePass（只读，`secrets.keepass`）

让 Agent 能用你 KeePass 数据库里的密码登录，但**密码照样不进模型上下文和聊天记录**。

1. **数据库从哪来**（二选一，可并用）：
   - **Drive 同步（推荐）**：配置 `secrets.keepass.sync.remote`（一个 rclone 远端路径，指向单个 `.kdbx`）。**每次 `/unlock` 时**先从 Drive 拉一次最新版，再发解锁按钮。不是后台定时任务：Drive 令牌每天只用几次，令牌失效时只给一条警告并继续用本机副本，不会因此打不开密码库；只在锁定状态下替换，绝不会在你使用中途把库锁掉。下载后核对 Drive 报告的 sha256 与大小，且必须是 KDBX 文件才会替换；任何失败都不动本机副本。
   - **手动发送**：把 `.kdbx` 直接发给 bot。bot 校验签名、原子替换为本机副本（保留一份 `.prev`）、从收件箱删掉，并**删除你发文件的那条消息**，让数据库文件不留在聊天记录里；文件不会交给模型。
   - 两者并用时遵循「新的覆盖旧的」：手动发送的文件，只有 Drive 上的版本在那之后又被修改过才会被替换，不会用旧版本悄悄覆盖你刚发的新文件。

   运维小技巧：重启 bot 之前 `touch /var/lib/pi-tg/unlock-on-start`，重启完成后 bot 会自动同步并把解锁按钮发给你（一次性，用完即删），省得再手动发 `/unlock`。

   Drive 授权建议用**只读**范围（`drive.readonly`）单独建一个 rclone 远端，不要复用有写权限的。
2. **解锁**：发 `/unlock`（或 Agent 调用 `keepass_unlock`）→ 点按钮 → 在一次性加密页输入主密码。输错可重试（5 次后链接作废）。`session` 模式（默认）下主密码**只在内存里用来打开数据库，不写磁盘**；解析完只保留解密后的条目，空闲 30 分钟自动锁定，最长 8 小时必锁，发 `/lock` 立即锁。
3. **使用**：`keepass_search` 按名称/网址/分组/标签找条目，只返回 id、标题、分组、用户名、网址、标签和有哪些额外字段，**从不返回密码和备注**。拿到 id 后：`secret_run` 里写 `env: {PASS: "kp:<id>#password"}`，或在其他工具参数里写 `{{secret:kp:<id>#password}}`。可用字段：`password`（默认）、`username`、`url`、`totp`（现算动态码，见下）、自定义字段名、`attachment:<文件名>`（文本附件，如 SSH 私钥，配合 `files` 用）。备注（Notes）不开放。TOTP 支持 KeePassXC 的 `otpauth://` 与旧格式 `key=…&size=…&step=…`（KeeOtp）、裸 base32，以及 KeePass 2 的 `TimeOtp-Secret[-Hex|-Base32|-Base64]` + `TimeOtp-Length/Period/Algorithm`（SHA1/256/512；Steam Guard 与 HOTP 不支持）。
4. 被取用的值**从读出那一刻起**就进入擦除名单（含 base64/URL 编码/JSON 转义；TOTP 码只在有效期后几分钟内擦），对工具输出、发给模型的上下文、Telegram 文本都生效；调用参数里保留的始终是占位符。

**用 KeePass 自己管控 Agent 能碰什么**（不用改 bot 配置）：

- 给条目加标签 `pitg-hidden`：Agent 看不到、搜不到，也取不到（报错与「不存在」一模一样，不泄露存在性）；回收站里的条目一律不可见；
- 给条目加标签 `pitg-confirm`：每次使用都会在 Telegram 弹出带条目标题、用户名、网址、字段和命令的允许/拒绝按钮（超时即拒绝）；
- 也可以按分组：`hiddenGroups`、`confirmGroups`（分组路径，大小写不敏感，含子组）。标签名可用 `hiddenTag`/`confirmTag` 改。

**确认弹窗的完整性**（参考「提示注入让 AI 把审批弹窗写成无害样子」的研究）：弹窗由程序用**真实参数**生成，不用 AI 写的摘要——命令**原样完整**展示（保留换行和缩进，不折叠、不截断）；不可见/改变显示方向的字符（U+202E、零宽、BOM、控制符）显示成 `<U+XXXX>`；命令里出现的地址由程序提取单独列出；对「管道到 shell / eval / 运行脚本文件 / base64 解码 / 网络传输」给出警告；已知的秘密值如果出现在命令里会显示成 `[SECRET:…]`。警告和地址放在命令**之前**。**命令超过 950 个字符就无法完整展示，直接自动拒绝**（不弹窗、不执行），而不是展示一个截断版本。

**异常使用的刹车**（不需要你配置）：

- 单次解锁里 AI 用过 `maxEntriesPerSession`（默认 8）个不同条目后，每个**新**条目都要你点确认——正常登录只需一两个，批量取很多条目就是异常；
- 每个条目的每个字段在一次解锁里**第一次**被用时，聊天里会收到一条不需点击的提示（条目标题、字段、命令前 160 字符，不含值），你随时能看到 AI 在用哪个凭据；
- `keepass_search` 每 10 分钟最多 30 次；空查询一次只列 15 条（防止一次性枚举全部账号）。

`config.json`（`{}` 即启用并使用默认值）：

```json
"secrets": { "baseUrl": "https://vault.example.com", "keepass": { "idleMinutes": 30, "maxHours": 8 } }
```

Drive 同步：`"keepass": { "sync": { "remote": "gdrive-ro:Folder/passwords.kdbx", "timeoutSeconds": 30 } }`。

可选项：`path`（默认 `/var/lib/pi-tg/keepass/main.kdbx`）、`mode`（`session` 或 `stored`）、`storedSecret`（默认 `keepass-master`）、`maxFileMb`（默认 64）、`maxEntriesPerSession`（默认 8）、`maxArgonMiB`（默认 256）。`stored` 模式把主密码存进保险库（`/secret keepass-master`，可勾「每次确认」），Agent 用到时自动解锁，免去每次输入，代价是数据库的保护强度降到与保险库相同（root 能同时读到密文和密钥即可打开整个 KeePass），仅在你接受这点时使用。

**Drive 授权**：有浏览器的机器上，直接 `rclone config` 新建一个 Drive 远端，范围选 `drive.readonly` 即可（也可以在别的机器上 `rclone authorize "drive" …` 再把结果粘贴回来）。服务器上没有浏览器、又只想用手机操作时，可以用自带的助手 `scripts/gdrive-oauth.ts`（回环地址 + 手动粘贴，带 PKCE 与 state）：

```sh
# 需要你自己的 Google OAuth 客户端（类型选 "Desktop app"）；可以复用一个现有 rclone 远端里的 client_id/secret
GDRIVE_OAUTH_CLIENT_REMOTE=gdrive node scripts/gdrive-oauth.ts start     # 打印授权链接，在手机上打开并同意
# 浏览器随后会跳到一个打不开的 http://127.0.0.1:53682/?code=… 页面：复制地址栏里的整串网址，
# 用 /secret 的加密输入页交给 Agent（授权码不要直接发进聊天），再由它执行：
REDIR='<粘贴的网址>' node scripts/gdrive-oauth.ts finish                  # 写入只读远端 gdrive-ro
```

`finish` 只接受恰好是 `drive.readonly` 的授权结果（更宽的、多出来的范围都拒绝），备份并小心改写 `rclone.conf`（只替换同名远端，其余逐字节不动，600 权限），**不会打印授权码或令牌**。如果令牌每隔约 7 天就失效，通常是 Google Cloud 的 OAuth 同意屏幕还处于「测试」状态，把它「发布」为生产状态即可（自用无需审核）。

**稳定性**：Argon2 解锁会一次性申请该数据库设定的内存（KeePassXC/KeePass2 默认约 64 MiB）。服务运行在 cgroup 内存上限里，一旦被撑破内核会杀掉整个 bot，所以解锁前会做两项预检——数据库的 Argon2 内存超过 `maxArgonMiB` 直接拒绝，当前剩余内存不够（页缓存不算占用）时干净地拒绝并提示稍后重试，不去赌。并发解锁共用一次计算；文件替换是原子的。读取库是 `kdbxweb`（纯 JS，Argon2 用 Node 自带的 `crypto.argon2`，不需要安装 KeePassXC）；它已基本不再更新，所以用 pykeepass 和 **KeePassXC 官方命令行**各生成一个真实数据库做兼容性夹具（`scripts/fixtures/`，TOTP 与 KeePassXC 自己的输出逐值对照），并把它依赖的 `@xmldom/xmldom` 用 `overrides` 固定到已修补的 0.8.15。

**限制**：只读（绝不回写数据库，不会与云端同步冲突）；暂不支持「主密码 + 密钥文件」组合、KDBX 1.x（`.kdb`）、Argon2 版本 1.0 的库、Steam Guard 与 HOTP。`search` 返回的标题/用户名/网址会发给你的模型服务商，这是 Agent 找到对的条目所必需的。

### 设计参考与取舍

做这个功能前对照过公开的同类方案，结论如下：

- **1Password / Bitwarden 的 agent 方案**：模型编排任务但拿不到凭据，由受信任的一侧在最后一步注入；敏感凭据每次使用要人确认并展示「用哪个、为什么」。这里同样如此（`secret_run` 注入、占位符在调用记录之后替换、每次确认的条目），并补上首次使用提示。
- **KeePassXC 自家的 browser 协议（keepassxc-mcp 等）**：由运行中的 KeePassXC 弹窗授权，数据库保持锁定。我们没有常驻的 GUI，所以用「一次性加密页输入主密码、只放内存、空闲自动锁」达到同样的「解锁是个明确动作」。
- **agents-vault（KeePassXC 密钥文件自动解锁）**：作者明确写了「所有 agent 平权、没有读取审计、只能放开发/实验凭据，绝不放生产凭据」。我们的 `stored` 模式就是这个取舍；`session` 模式 + 标签/分组 + 审计 + 预算是为了装得下更重要的账号。
- **安全研究的共同结论**：审批界面如果由模型生成就不是安全边界；凭据发现要限制；异常用量要有刹车；输出要擦除；凭据不能进环境变量之外的明文位置。对应上面的完整性规则、搜索限流、条目预算和擦除器。
- **没有借用的**：按域名绑定凭据（keepassxc-browser 按 URL 匹配）——在「AI 自己写命令」的场景里命令里的域名无法证明目的地，做了也只是假的安全感，所以只做展示与警告，不做放行判断。

### 诚实的边界

- 保险库用 AES-256-GCM 加密落盘，但守护进程必须**无人值守解密**（这正是「不用逐次批准」的前提），所以能同时读到密文和密钥文件的 root 仍可读出明文。它防的是：聊天记录、会话文件、模型上下文、Git、状态目录备份、随手 `cat`/`grep`。
- 输出擦除防的是**意外**泄漏（报错回显、`curl -v`、页面快照）。一个主动想外传的 Agent 可以绕过字符串匹配（比如 `rev`），也可能被网页里的提示词注入诱导。对主力账号请勾选「每次使用前确认」；所有使用都会记入 `secrets-audit.jsonl`（只记名称/工具/命令摘要，不含值）。
- 少于 6 个字符的值无法擦除（误伤太多），保存时会提示。
- **没有出站网络限制**：只要 AI 能自己写命令，被提示注入的 AI 完全可以 `curl` 把一个**不需确认**的凭据发出去，输出擦除拦不住。确认弹窗只管「需确认」的条目；其余的靠预算、首次使用提示和审计事后发现。对重要账号请打上 `pitg-confirm`（或不要放进给 AI 用的库，用 `pitg-hidden`）。
- 确认弹窗展示的是命令原文，但命令如果去**运行一个脚本文件**，文件内容不在弹窗里（会有警告，但无法审阅）。
- 「只放内存」不等于立刻抹掉：JS 字符串无法清零，主密码和解密后的条目在进程内存里直到被回收/覆盖；也无法阻止系统换页。systemd 单元建议加 `LimitCORE=0`（见 `systemd/` 里的说明），避免崩溃时把内存写进核心转储。
- 如果你仍把密码直接发进了聊天：先把它存进保险库，之后同一值会从发给模型的上下文里被擦掉；但 Telegram 服务器上的记录仍在，请视情况更换。
- 浏览器端加密挡不住「能替你提供页面 JS 的攻击者」，那已经等于拿下了这台主机。

## 内置 Web 与视觉工具

### `pi-web-access`

默认 `pi-web-access` 注册四类能力：

- Web 搜索；
- 网页/文档/视频内容抓取；
- 来源与事实核查；
- 检索前一次搜索或抓取保存的完整内容。

工具公开名称可以由 `web-search.json` 的 `toolNames` 修改，因此实际会话中可能显示为 `web_search` / `fetch_content`，也可能显示为自定义名称。

### `pi-email`

项目将 `@patimweb/pi-email` 以源码形式 vendored 到 `vendor/pi-email/`，并作为内置扩展加载。可用工具包括：

- `email_setup`、`email_status`：配置和查看邮箱账户；
- `email_list_mailboxes`、`email_fetch`、`email_read`、`email_search`：列出文件夹、获取邮件、读取正文和搜索；
- `email_send`、`email_reply`、`email_forward`：发送、回复和转发；
- `email_move`、`email_delete`、`email_flag`：移动、删除和设置 IMAP 标记。

首次使用前调用 `email_setup`。凭证写入当前服务账号的 `~/.pi/email-config.json`，目录权限为 `0700`，文件权限为 `0600`。vendor 版本还包含连接失败拒绝、TLS SNI、连接超时和 `email_flag` 异常传播修复，避免邮箱连接失败挂起整个 Agent turn。升级或替换上游邮件扩展时，需要重新检查并重新套用 `vendor/patches/README.md` 中的补丁。

### `image-describe` Skill

项目内置 `image-describe` 识图 skill：

- **多模态视觉模型**（如 Gemini 3.7 Flash、Claude Sonnet、GPT-4o/5 等）：优先通过 SDK 内置的 `read` 工具进行原生识图，不消耗额外 API 额度；
- **纯文本模型**（如 DeepSeek、GLM 等）：自动降级调用 `skills/image-describe/scripts/describe.sh`，通过 OpenRouter（支持 Gemma 4 26B 等轻量视觉模型）识别图片内容。可通过环境变量 `OPENROUTER_API_KEY` 或在 `~/.pi/agent/auth.json` 中配置 OpenRouter Key。

## 数据存储与内置保护

项目重点不是安全拦截，但仍保留一些避免误操作或意外公开的基本机制：

- 非 `allowedUserId` 的更新不会交给 Agent，操作者在群聊中的更新也会被拒绝；
- SDK 的用户消息事件不会进入助手正文渲染，避免实时消息重复显示 Prompt；
- Bot 的 callback 带进程和 session generation 标识，旧按钮不能操作新会话；
- `config.json`、凭证、模型目录、session、日志、inbox、本地审计报告和 `web-search.json` 默认被 Git 忽略；
- journald 对 Prompt、模型正文、聊天/消息/session ID 等字段进行省略；错误诊断会记录经启发式脱敏的短消息及栈位置，仍可能带有私有路径或非典型敏感内容，应按私人日志保护；
- 发往 Telegram 的模型输出会尝试遮盖常见 API Key、Bot Token、JWT、私钥块和带密码的数据库 URL；
- 工具审计不保存原始参数或工具结果，只保留参数字节数和摘要哈希；
- `publication-check` 检查常见敏感文件名、凭证格式，并默认拒绝图片资产（图片需先人工隐私审查）；
- 出站文件只能来自配置允许的目录，拒绝符号链接，并采用流式上传避免把整个文件载入内存；
- 启用「可选插件」后，保险库（`vault.json`，AES-256-GCM）与主密钥文件分开存放，KeePass 数据库副本、来源记录和使用审计都是 600/700 权限，默认被 Git 忽略（`vault.json`、`*.kdbx`、`*.key`），`publication-check` 也会拒绝它们（仅 `scripts/fixtures/` 里的假数据库例外）。

这些机制都是有限的、启发式的：

- 它们不是容器、虚拟机或权限隔离；
- 它们不能证明模型、中转站、扩展或网页内容可信；
- 它们可能漏掉非典型凭证，也可能误判普通文本；
- Agent 最终仍拥有运行服务账号的实际系统权限。

生产使用时，最有效的边界仍然是：**低权限服务账号、独立工作目录、最小化工具权限、可信 provider，以及不向 Agent 提供不必要的数据。**

## 测试

```bash
npm test
```

测试包括：

- TypeScript 类型检查；
- 流式 Markdown/Telegram HTML 前缀和标签闭合；
- 出站脱敏及误报样例；
- Telegram UI 超时、失败和 AbortSignal 中断行为；
- 实时工具状态、用户消息角色过滤、Prompt 复述过滤、思考渲染和软编辑上限；
- 超长单行文字/代码的完整分段；
- 单用户私聊边界与群聊拒绝；
- 危险配置、配置文件权限、出站符号链接和审计日志明文回归测试；
- 流式 multipart 文件上传及文件名处理；
- 模型思考等级与 provider payload 兼容；Anthropic 在系统提示词改变后恢复同一会话、thinking beta Header 合并、流式正文/用量及 off-mode 回归；
- 状态恢复、滑动空闲超时和操作面板；
- 内置 `pi-web-access` 加载及四类能力注册；
- 本地 vendored `pi-email` 扩展加载及 IMAP/SMTP 工具注册，以及离线 MIME/附件/回复线程、密送隐私和文件/URL 访问限制；（`npm run test:email`）
- 内置 `image-describe` skill 加载与校验；
- 可选插件（`npm run test:secrets`）：未配置时不加载任何插件代码、缺少 `kdbxweb` 时 KeePass 自动关闭而保险库照常可用；加密信封与一次性链接服务（真实 HTTP）；保险库与输出擦除；确认弹窗的完整性（原样展示、不可见字符、过长即拒绝）；KeePass 读取（pykeepass 与 KeePassXC 官方命令行各生成一个真实数据库作为夹具，TOTP 与 KeePassXC 自己的输出逐值对照）；Drive 同步的各种失败都不动本机副本；Drive 授权助手；以及用真实 pi SDK + 脚本化假模型确认密码、自定义字段和 TOTP 码不会出现在任何发给模型的请求或落盘的会话文件里；
- 公开发布文件、图片资产、常见凭证扫描，以及密码库/保险库文件拦截。

可选的真实 SDK 探针会创建隔离 session 并实际请求当前模型：

```bash
npm run probe
```

它需要有效 provider 凭证，可能产生模型用量。需要时可覆盖路径：

```bash
PI_TG_PROBE_CWD=/srv/pi-tg/workspace \
PI_TG_PROBE_AGENT_DIR=/var/lib/pi-tg/agent \
npm run probe
```

## 日常运维

```bash
systemctl status pi-tg
journalctl -u pi-tg -f
systemctl restart pi-tg
```

程序会处理：

- Bot Token 无效时以状态码 78 退出，示例 unit 不会对该状态无限重启；
- Telegram 409 表示另一个 webhook 或 long-poll consumer 正在使用相同 Token；
- 启动时删除已有 webhook，因为本项目使用 long polling；
- Telegram 429 的 `retry_after`；
- 卡住的可幂等 Telegram API 请求会换新连接重试一次；`sendMessage` 超时不盲目重试，以免重复发送。最终正文的未确认分段保留供 `/retry`。

`check-pi-update.sh` 可选地检查 pi SDK 新版本，并通过同一个 Bot 发送升级提醒：

```bash
PI_TG_CONFIG=/etc/pi-tg/config.json /opt/pi-tg/check-pi-update.sh
```

升级前请先备份必要配置、session、state 及交付队列；不要覆盖或删除旧数据后再假设一定能恢复。依赖升级后运行 `npm test` 和 `npm audit --omit=dev`，确认当前任务及最终消息送达结束后再重启。本版邮件依赖为 Mailparser 3.12.4 / Nodemailer 10.2.1，保留 utf7 的 semver 5.7.2 override。

### 已知依赖风险

截至本版发布检查，`npm audit --omit=dev` 仍报告 **4 项** SDK 依赖链问题（1 项 moderate、3 项 high），涉及 SDK 汇总条目以及其嵌套的 undici、brace-expansion、zod。顶层邮件依赖已更新，但这不等于 SDK 内部依赖同步修复。请按实际部署重新审计，另行验证 SDK 升级方案；不要把本文或一次离线测试当作安全保证。

## 公开 Fork 前的隐私检查

建议在独立、干净的 clone/worktree 中整理公开版本，按文件白名单挑选通用源码；不要直接在生产目录执行 `git add .`。部署专用扩展、模型探针、依赖备份和运行数据应留在仓库之外。

先人工审核文件，再暂存明确要发布的内容，最后执行：

```bash
npm test
git status --short
git diff --cached --name-status
git diff --cached --check
npm run publication-check -- --staged
```

默认扫描检查当前工作目录；`--staged` 则只读取 Git 暂存区的实际 blob，即使工作副本随后被修改，也不会把它误当成待提交内容。输出只包含文件位置和规则名，不回显匹配到的密钥。自动扫描不能识别所有个人资料，仍须人工检查完整暂存差异。

发布前还建议使用 Gitleaks 等工具在本机扫描 Git 历史。设置 GitHub 的 `noreply` 提交邮箱，避免在 commit/tag 元数据里暴露私人邮箱。不要把真实配置、聊天历史或扫描原始报告上传到第三方扫描网站。

确认提交中只有 `config.example.json`，没有真实部署数据，尤其不要提交：

- Telegram Bot Token、用户 ID 或 chat ID；
- pi 的 `auth.json`、私有 `models.json` 或 `web-search.json`；
- 中转站 API Key、自定义 Header 或带凭证的 URL；
- session 记录和 `*.jsonl`；
- Telegram 下载文件；
- state、audit、应用日志和配置备份；
- 私有域名、IP、主机名、用户名及个人绝对路径；
- 真实的 KeePass 数据库（`*.kdbx`）、保险库文件 `vault.json`、主密钥文件、rclone 配置（含 Drive 令牌）和 Drive 里的真实文件路径。测试夹具 `scripts/fixtures/*.kdbx` 只含假数据，用文档保留地址（`203.0.113.0/24`）；自己重新生成夹具时同样不要带入真实条目，加密在库里的内容 `grep` 是搜不到的，需要用 `kdbxweb` 解开后检查。

如果真实密钥曾进入 Git 历史，仅在新提交中删除是不够的。应立即吊销/轮换密钥，并按需重写 Git 历史。

## 已知限制

- 只支持一个 Telegram 操作者和一个长期 Agent 会话；
- 只支持 long polling，启动时会移除 webhook；
- 暂不转写语音消息；
- 图片以本地文件路径交给 Agent（多模态模型原生支持，纯文本模型可通过内置 `image-describe` skill 进行视觉兜底）；
- 视频贴纸预览依赖 `ffmpeg`；
- provider 不返回 thinking 内容时，Telegram 只能显示“思考中”阶段，无法展示具体内容；
- thinking/reasoning 是否可见、格式和完整程度取决于 provider；
- 项目不是安全沙箱，模型拥有服务账号可用的真实工具权限；
- 当前实现绑定 `package.json` 中固定的 pi SDK、`pi-web-access` 和邮件运行时依赖版本，升级后应重新运行完整测试和 probe；
- `vendor/pi-email` 是经过本地补丁的上游源码副本，更新上游版本时必须重新检查补丁和邮件测试。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
```

修改时应保持以下行为：

- Telegram polling 不能等待 Agent 任务结束；
- 真实 Agent run 必须等待 `agent_settled` 和最终交付收束才释放 dispatcher；被扩展直接处理、从未启动 Agent 的命令不能等待不存在的 settled 事件；
- 用户、toolResult 和 custom 等非助手角色不能进入助手正文或思考渲染；
- 旧 session generation 的事件不能渲染到新会话；
- 每一个流式前缀都必须生成结构闭合的 Telegram HTML；
- 工具参数、工具输出和思考内容的实时展示必须有长度边界；
- 模型/provider 的思考档位应与真实 wire 行为一致；
- 真实配置、凭证和运行数据不能进入公开仓库。

## License

[MIT](LICENSE)

## 致谢

基于 pi coding-agent SDK、Telegram Bot API 和 `pi-web-access` 构建。本项目是独立集成，与 Telegram 官方无关联。
