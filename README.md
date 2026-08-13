# pi-tgbot

把 [pi coding agent](https://github.com/badlogic/pi-mono) 搬进 Telegram 的单用户机器人。

它基于 `@earendil-works/pi-coding-agent` SDK，长期运行一个独立、可恢复的 pi 会话。你可以直接在 Telegram 中发任务、查看模型输出、观察当前工具调用和运行状态，并通过按钮切换模型、调整思考等级、中断任务或创建新会话。

这个项目的重点是：**让 pi 在 Telegram 中真正可用，而且长任务的运行过程足够直观。** 它不是一个以“安全拦截”为主要功能的项目，也不是沙箱。

## 主要功能

- **Telegram 实时输出**：模型生成正文时持续编辑同一条消息，不必等整轮任务结束。
- **实时运行状态**：显示思考、准备调用工具、工具名称、参数摘要、执行进度、重试和上下文压缩等状态。
- **可见思考内容**：当模型 API 返回可展示的 thinking/reasoning 内容时，会在独立的可折叠引用块中实时显示；若思考开头只是原样复述本轮 Prompt，则仅隐藏这段开头复述，后续思考照常显示；被 provider 标记为 redacted 的内容不会展示。
- **长任务不会“假死”**：普通状态更新达到软上限后可以降频，但新的思考内容和正文仍会继续更新。
- **可靠的最终送达**：较长任务完成后会另发新消息触发 Telegram 通知；超长回答会按 Telegram 限制安全分段。
- **持久会话**：服务重启后恢复最近的专用会话；模型和思考等级也会保留。
- **非阻塞轮询**：Agent 运行期间仍继续接收 Telegram 消息，后续任务按到达顺序排队。
- **操作面板**：查看状态、Token 用量、上下文占用、当前工具，切换模型和思考等级，创建新会话、中断任务或一键重启服务。
- **模型 reasoning 兼容**：针对多种模型家族补充真实可用的思考档位和请求格式，避免面板展示 endpoint 实际不支持的等级。
- **内置 Web 能力**：固定依赖并自动加载 `pi-web-access`，提供网页搜索、正文抓取、来源核查、PDF、GitHub 仓库和视频处理能力。
- **文件与贴纸**：接收照片、文档和 Telegram 贴纸；可把生成的本地文件发回当前对话。
- **扩展 UI**：pi 扩展的 `confirm`、`select` 等交互可以映射为 Telegram 内联按钮。
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

Bot 对话经过 Telegram Bot API，不是 Secret Chat。不要在聊天中直接发送长期密码、私钥、恢复码或其他不可撤销的敏感信息。实时展示的工具参数、思考内容和最终回答也会留在 Telegram 聊天记录中。

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
 Dispatcher ── 当前任务 + FIFO 等待队列
        │
        ▼
 AgentHost ── pi SDK 的持久 AgentSession
        │              │
        │              ├── 内置 pi-web-access
        │              ├── 显式配置的扩展
        │              ├── 内置与自定义工具
        │              └── 独立 session 目录
        ▼
 Event Router ── 正文 / 思考 / 工具 / 生命周期事件
        │
        ▼
 LiveMessage ── 脱敏 → Markdown/HTML → 限速/分段
        │
        ▼
 Telegram 对话
```

主要源码：

- `src/main.ts`：进程生命周期、任务队列、命令、回调、附件和退出流程。
- `src/agent/host.ts`：pi SDK 初始化、会话恢复、模型/思考等级和扩展加载。
- `src/agent/events.ts`：把 pi 事件流转换成 Telegram 中可见的正文、思考和工具状态。
- `src/agent/reasoning.ts`：模型家族的思考档位与 provider 请求兼容。
- `src/telegram/poller.ts`：Telegram 长轮询、用户限制、冲突恢复和退避。
- `src/telegram/live.ts`：实时消息编辑、限速、思考块、最终通知和分段。
- `src/telegram/markdown.ts`、`html.ts`：把流式 Markdown 编译成 Telegram 可接受的闭合 HTML。
- `src/telegram/files.ts`：附件下载、文件名处理、保留期限和出站目录限制。
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
- 可选：安装 `ffmpeg`，用于视频贴纸预览以及部分网页/视频能力。

## 安装

### 1. 克隆并安装依赖

```bash
git clone https://github.com/harrylyu2006/pi-tgbot.git
cd pi-tgbot
npm ci --ignore-scripts
```

`pi-web-access` 已固定在 `package.json` 中并由程序自动加载，不需要另外执行 `pi install`。`--ignore-scripts` 可减少依赖安装阶段执行生命周期脚本的风险；当前正常运行不依赖这些脚本。

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

程序会拒绝未知配置字段，避免拼写错误被静默忽略。完整示例见 `config.example.json`。

### 必填项

- `botToken`：格式为 `<数字ID>:<secret>` 的 Telegram Bot Token。
- `allowedUserId`：唯一允许访问机器人的 Telegram 数字用户 ID。

### 路径与状态

- `cwd`：Agent 工作目录；内置文件和 Shell 工具默认在这里执行。
- `agentDir`：pi 的设置、认证、模型、技能和上下文目录。
- `sessionDir`：本 Bot 专用会话目录，不能与交互式 pi 的默认 session 目录混用。
- `statePath`：保存已见 update、上次任务中断状态、模型和思考等级。
- `auditPath`：追加写入的工具审计日志；只记录工具名、时间、参数字节数和参数摘要哈希，不保存原始参数或工具结果。

### 实时消息

- `render.editThrottleMs`：同一消息两次编辑之间的最小间隔，不得低于 1000ms。
- `render.maxChars`：单条实时消息的目标长度，需要低于 Telegram 的 4096 字符限制。
- `render.maxEditsPerTurn`：普通状态更新的软上限；新的思考或正文仍可继续更新。
- `render.notifyAfterMs`：任务超过该时长后，结束时另发新消息以触发通知。

### 任务与队列

- `turn.idleTimeoutMs`：只有连续这么久没有请求或 Agent 进度事件才会中断任务，不是整轮任务的固定时限。
- `coldStart.staleSeconds`：服务启动时，早于该时间的积压消息会被确认并跳过，避免重启后突然执行旧任务。

### 工具与扩展

- `tools.deny`：需要停用的工具名，例如只读部署可禁用 `bash`、`write`、`edit`。
- `tools.extraActive`：额外启用的已注册工具。
- `extensions`：额外加载的本地路径或 `npm:` specifier。环境中的扩展不会被自动扫描。
- 内置 `pi-web-access` 始终从本项目依赖目录加载；若在 `extensions` 里重复填写，会自动去重。

### 文件

- `files.inboxDir`：Telegram 下载文件保存位置，按日期建立子目录。
- `files.outboxRoots`：`telegram_send_file` 允许读取的根目录。必须是非空绝对路径；程序拒绝 `/`，并在发送前解析真实路径、拒绝符号链接。不要配置整个 HOME。
- `files.maxDownloadMb`：入站文件大小上限。
- `files.maxUploadMb`：发回 Telegram 的文件大小上限。
- `files.retentionDays`：启动时清理多少天以前的收件目录。

## Telegram 命令与面板

- `/start`、`/help`、`/panel`：打开操作面板；
- `/status`：查看模型、思考等级、上下文和运行状态；
- `/tokens`、`/usage`：查看累计 Token、缓存、成本和上下文占用；
- `/new`：丢弃当前上下文，创建一个新的专用会话；
- `/stop`：中断当前 Agent 任务。

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

## 内置 Web 工具

默认 `pi-web-access` 注册四类能力：

- Web 搜索；
- 网页/文档/视频内容抓取；
- 来源与事实核查；
- 检索前一次搜索或抓取保存的完整内容。

工具公开名称可以由 `web-search.json` 的 `toolNames` 修改，因此实际会话中可能显示为 `web_search` / `fetch_content`，也可能显示为自定义名称。

## 数据存储与内置保护

项目重点不是安全拦截，但仍保留一些避免误操作或意外公开的基本机制：

- 非 `allowedUserId` 的更新不会交给 Agent，操作者在群聊中的更新也会被拒绝；
- Bot 的 callback 带进程和 session generation 标识，旧按钮不能操作新会话；
- `config.json`、凭证、模型目录、session、日志、inbox 和 `web-search.json` 默认被 Git 忽略；
- journald 不记录完整 prompt 和模型正文；
- 发往 Telegram 的模型输出会尝试遮盖常见 API Key、Bot Token、JWT、私钥块和带密码的数据库 URL；
- 工具审计不保存原始参数或工具结果，只保留参数字节数和摘要哈希；
- `publication-check` 检查常见敏感文件名、凭证格式，并默认拒绝图片资产（图片需先人工隐私审查）；
- 出站文件只能来自配置允许的目录，拒绝符号链接，并采用流式上传避免把整个文件载入内存。

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
- Telegram UI 超时/失败行为；
- 实时工具状态、思考渲染和软编辑上限；
- 模型思考等级与 provider payload 兼容；
- 状态恢复、滑动空闲超时和操作面板；
- 内置 `pi-web-access` 加载及四类能力注册；
- 公开发布文件与常见凭证扫描。

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
- 卡住的非装饰性 Telegram API 请求会换新连接重试一次。

`check-pi-update.sh` 可选地检查 pi SDK 新版本，并通过同一个 Bot 发送升级提醒：

```bash
PI_TG_CONFIG=/etc/pi-tg/config.json /opt/pi-tg/check-pi-update.sh
```

升级前请先备份必要配置和 session；不要覆盖或删除旧数据后再假设一定能恢复。

## 公开 Fork 前的隐私检查

推送自己的 Fork 前至少执行：

```bash
npm run publication-check
git status --short
git diff --cached --check
```

确认提交中只有 `config.example.json`，没有真实部署数据，尤其不要提交：

- Telegram Bot Token、用户 ID 或 chat ID；
- pi 的 `auth.json`、私有 `models.json` 或 `web-search.json`；
- 中转站 API Key、自定义 Header 或带凭证的 URL；
- session 记录和 `*.jsonl`；
- Telegram 下载文件；
- state、audit、应用日志和配置备份；
- 私有域名、IP、主机名、用户名及个人绝对路径。

如果真实密钥曾进入 Git 历史，仅在新提交中删除是不够的。应立即吊销/轮换密钥，并按需重写 Git 历史。

## 已知限制

- 只支持一个 Telegram 操作者和一个长期 Agent 会话；
- 只支持 long polling，启动时会移除 webhook；
- 暂不转写语音消息；
- 图片以本地文件路径交给 Agent，纯文本模型需要额外视觉工具或 skill；
- 视频贴纸预览依赖 `ffmpeg`；
- provider 不返回 thinking 内容时，Telegram 只能显示“思考中”阶段，无法展示具体内容；
- thinking/reasoning 是否可见、格式和完整程度取决于 provider；
- 项目不是安全沙箱，模型拥有服务账号可用的真实工具权限；
- 当前实现绑定 `package.json` 中固定的 pi SDK 与 `pi-web-access` 版本，升级后应重新运行完整测试和 probe。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
```

修改时应保持以下行为：

- Telegram polling 不能等待 Agent 任务结束；
- 只有 `agent_settled` 才能释放 dispatcher；
- 旧 session generation 的事件不能渲染到新会话；
- 每一个流式前缀都必须生成结构闭合的 Telegram HTML；
- 工具参数、工具输出和思考内容的实时展示必须有长度边界；
- 模型/provider 的思考档位应与真实 wire 行为一致；
- 真实配置、凭证和运行数据不能进入公开仓库。

## License

[MIT](LICENSE)

## 致谢

基于 pi coding-agent SDK、Telegram Bot API 和 `pi-web-access` 构建。本项目是独立集成，与 Telegram 官方无关联。
