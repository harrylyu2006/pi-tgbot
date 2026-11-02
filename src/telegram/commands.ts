/** Commands the daemon always handles. */
export const CORE_COMMANDS = [
	{ command: "start", description: "操作面板" }, { command: "tokens", description: "Token 用量统计" },
	{ command: "status", description: "当前状态" }, { command: "new", description: "开一个新会话（清空上下文）" },
	{ command: "stop", description: "中断当前任务" }, { command: "restart", description: "一键重启服务" },
	{ command: "help", description: "帮助" }, { command: "retry", description: "重发未确认送达的回答（不重跑任务）" },
];

/** Added only when the optional `secrets` plugin is configured. */
export const SECRET_COMMANDS = [
	{ command: "secret", description: "安全输入密码：/secret 名称（加密网页，不进聊天记录）" },
	{ command: "secrets", description: "列出已保存的密钥名称（不显示值）" },
];

/** Added only when `secrets.keepass` is configured as well. */
export const KEEPASS_COMMANDS = [
	{ command: "unlock", description: "解锁 KeePass（加密网页输入主密码）" },
	{ command: "lock", description: "立即锁定 KeePass" },
];

/** Every command the daemon can handle (offline menu maintenance and tests check that each one has a handler). */
export const COMMANDS = [...CORE_COMMANDS, ...SECRET_COMMANDS, ...KEEPASS_COMMANDS];

/** The menu to publish for this deployment: plugin commands appear only when the plugin is on. */
export function commandsFor(opts: { secrets: boolean; keepass: boolean }): typeof COMMANDS {
	return [...CORE_COMMANDS, ...(opts.secrets ? SECRET_COMMANDS : []), ...(opts.secrets && opts.keepass ? KEEPASS_COMMANDS : [])];
}
