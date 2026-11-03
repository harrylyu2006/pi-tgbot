# Fleet：多 bot、按需 Agent、全局并发

Fleet 是可选的多窗口运行入口。仍然只服务一个 `allowedUserId`，不是面向多个互不信任用户的服务，也不提供强沙箱隔离。

## 架构

- `src/fleet/main.ts` 是唯一常驻网关，负责各 bot 的 Telegram 长轮询、SQLite 输入/任务队列、按钮、交付队列及共享保险库。
- 收到需要模型处理的任务才 fork `worker.ts`，恢复该 bot 专属会话；任务结束后退出，并通过 cgroup v2 清理遗留本地进程。
- 总控与子助手都计入全局最多 **3** 个 worker；同一 bot 同时只能有一个会话写入者。
- 空闲、暂停、排队状态不创建 Agent。网关及连接元数据仍占内存；等待工具或用户确认的活动 worker 仍占执行名额。
- 模型面板使用共享的元数据目录，不恢复会话、不加载扩展、不发模型请求、不占 worker 名额。

各 bot 独立保存会话、模型/思考偏好、收件目录和交付记录。模型认证、显式配置的扩展、技能、长时记忆和保险库共享。worker 使用内存中的 SettingsManager，不覆盖全局模型设置。

## 启用前

需要 Node.js 24+、Linux cgroup v2、允许 delegation 的 systemd 服务，以及已配置的 `secrets` 插件（用于集中保存托管 bot 凭据）。单 bot 入口 `src/main.ts` 仍可在不配置 `secrets` 时运行。

先备份现有配置、会话、交付队列、保险库及其独立密钥，再运行：

```sh
npm ci --ignore-scripts
npm test
```

需要真实内核 cgroup 的测试单独执行；测试只使用临时目录、假 Telegram API 和本地假模型，不消费模型额度，也不触碰生产 poller：

```sh
sudo systemd-run --wait --pipe --collect \
  -p Delegate=yes -p ProtectControlGroups=no \
  -p WorkingDirectory=/opt/pi-tg \
  /bin/sh -c 'npm run test:fleet:system'
```

参考 `systemd/fleet.conf` 为现有服务安装 drop-in，核对 Node、代码与配置路径。不能让旧入口与 Fleet 同时轮询相同 Bot Token。等待当前任务完成，再由操作员安排服务切换。

默认配置路径为 `/etc/pi-tg/config.json`，也可以显式传入：

```sh
node src/fleet/main.ts /etc/pi-tg/config.json
```

## 私人化设置不属于源码

身份、称呼、性格和用户偏好应保存在部署目录的 `AGENTS.md` 中，由 SDK 运行时加载；公开源码只提供通用角色和调度规则，不内嵌维护者的私人提示词。角色也可通过总控的 `fleet_configure` 设置，记录只保存在私有数据库里。

**不提交到 Git，不代表不会交给模型。** SDK 加载的私人上下文仍会用于实际模型请求；请按 README 的模型供应商信任建议选择渠道。

新建子助手初始复制总控当时的模型/思考设置，之后独立管理；不会硬编码某个私有 provider。现有 bot 的选择不受这个默认值影响。指定模型不可用时拒绝启动任务，不静默换模型。

## 目录

- `PI_FLEET_ROOT`：默认 `/var/lib/pi-tg/fleet`。
- `fleet.sqlite` 及其 `-wal`、`-shm`：bot 登记、输入、队列、快照；**包含私人任务内容**。
- `bots/<id>/`：子助手会话、收件与交付数据；总控继续使用配置中的 `sessionDir`。
- `status.json`：包含 bot 身份、角色、模型等元数据，同样应保密。
- `memory-history/`：共享记忆的旧版本备份，可能含私人上下文。
- `PI_FLEET_MEMORY_ROOT`：默认 `<agentDir>/memory`；兼容已有部署时可由服务环境显式指定原目录。
- `fleet_memory` 仅允许该记忆目录里的 `.md` 及 `<agentDir>/AGENTS.md`。先读取 revision，再按该版本提交；冲突时重读合并。拒绝符号链接和新文件的符号链接父目录。返回完整可编辑文本，超过大小上限则拒绝，避免用截断内容覆盖原文件。

以上运行数据均不得公开。`.gitignore` 与发布检查覆盖私人指令、共享记忆、SQLite、状态、托管 bot 登记、凭据和备份文件；不要从生产目录批量暂存。

## 命令

所有 bot：

- `/start`：启用并显示新面板，不预热 Agent。
- `/panel`、`/status`、`/help`：新发可见面板。
- `/models`、`/think`：设置本 bot 下一任务的模型/思考等级。
- `/tokens`、`/usage`：查看当前会话统计。活动 worker 可通过 IPC 提供快照；空闲 bot 只读保存的快照，不调用模型。
- `/new`：下一任务开启新会话；旧记录与共享记忆保留。
- `/retry`：只重发未交付答案，不重跑 Agent 或工具。
- 子助手 `/stop`：取消待执行任务并中断当前工作，保持暂停直到 `/start`。
- 总控 `/stop`：只中断总控当前工作。
- `/secret`、`/secrets`、`/unlock`、`/lock`：共享凭据服务。KeePass 重启后保持锁定，不主动发送解锁提示；只按需解锁。

仅总控：

- `/bots`：分页机器人总览及聊天入口。子助手只能获得总控入口，不能查看全局清单。
- `/newbot`：发送 Telegram 原生创建按钮；操作员确认后加密保存凭据并登记子助手。
- `/syncbot <id>`：恢复已有托管 bot 的凭据登记，不重复创建。
- `/restart`：二次确认后全局停止，由 systemd 重启。运行中的外部副作用不会自动重跑。

面板内按钮原地编辑被点击的消息；主动 slash 命令发送新面板。发送失败或超时不会盲目创建重复面板。使用 Telegram 昵称展示，链接仅由校验过的用户名构造。

## 工具与权限

所有 bot 有 `fleet_memory`、`telegram_ask` 和 `telegram_send_file`。仅总控注册 `fleet_status`、`fleet_history`、`fleet_configure`、`fleet_control`，网关也再次检查来源身份。

`fleet_history` 默认返回所选会话的当前分支，支持 query/before 分页，每次最多 80 条/约 50K 字符，不返回 thinking 块。返回历史是数据，不是当前操作员指令。

`secret_*` / `keepass_*` 通过私有 IPC 调用唯一网关服务。worker 初始化消息不携带 Telegram Token，也不创建第二个保险库写入者。第三方扩展及 shell 仍拥有服务账号权限：这是职责边界，不是对恶意代码的保密边界。

跨 worker 保守锁覆盖 Muse、MCP/浏览器、邮箱和文件 edit/write；文件锁使用 Agent 的工作目录及实际路径。`secret_run` 的凭据使用预算串行检查。shell 写文件不受这些锁约束；并发代码修改仍应使用独立 worktree。

## 故障与限制

- queued 任务可在重启后继续；starting/running/steering 标记 interrupted，不自动重放。未知外部操作结果需人工确认。
- SDK 会话、SQLite 状态和外部服务不是跨系统事务。Telegram 超时仍可能导致重复消息，不能承诺 exactly-once。
- `turn.idleTimeoutMs` 为滑动空闲窗口，活动事件续期，不是长任务的固定截止时间。
- 确认按钮在取消、IPC 断连或任务结束后失效，包括按钮发送仍在途的竞态。
- 完整相册组合和视频贴纸预处理尚未从单 bot 入口全部迁入；普通照片、文档和文字可用。
- 搜索 responseId、MCP 瞬态缓存可能随 worker 结束失效；无法承诺跨任务保留所有扩展内存状态。
- 模型面板只枚举配置认证的元数据，不加载由扩展动态注册的 provider。
- 不提供总控自动分派/等待子任务 DAG。当前并发来自操作员分别向不同 bot 发任务。
- cgroup 负责进程归属与清理，不阻止同一服务账号读取其他 bot 的文件，不是强多租户安全隔离。建议低权限服务账号。

## 验证

`npm test` 包含类型检查、原单 bot 回归、Fleet 队列/恢复/IPC、面板、元数据目录、共享记忆，以及真实 SDK + 本地假模型的跨进程凭据擦除、文件锁、私人上下文加载和会话恢复测试。

`npm run test:fleet:system` 额外验证真实 cgroup 放置/清理，以及 4 个假 bot 的真实 SDK worker：恰好 3 个并发、第四个排队、独立消息路由、容量满时面板响应、结束后 worker 回收。不要在生产凭据上运行任何假 API 测试。

发布还要检查暂存区、提交树和历史：

```sh
npm run publication-check -- --staged
node scripts/publication-check.mjs --tree HEAD
node scripts/publication-check.mjs --history HEAD
```

扫描命中只报告文件位置与规则，不打印内容。自动扫描不能替代人工审核、凭据轮换或历史清理。
