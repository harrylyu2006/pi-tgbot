/** Shared by startup registration and the offline menu maintenance command. */
export const COMMANDS = [
	{ command: "start", description: "操作面板" }, { command: "tokens", description: "Token 用量统计" },
	{ command: "status", description: "当前状态" }, { command: "new", description: "开一个新会话（清空上下文）" },
	{ command: "stop", description: "中断当前任务" }, { command: "help", description: "帮助" },
	{ command: "retry", description: "重发未确认送达的回答（不重跑任务）" },
];
