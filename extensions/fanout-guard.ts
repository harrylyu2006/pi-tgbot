/**
 * Fan-out guard: confirm before anything runs across many machines at once.
 *
 * The threat this addresses is prompt injection turning into fleet-wide damage.
 * Injected instructions do not need a scary verb to be catastrophic — the
 * damage comes from *scale*. `for h in $(cat hosts); do ssh $h 'systemctl stop
 * nginx'; done` contains no dangerous keyword and takes down everything.
 *
 * So the trigger here is breadth, not danger:
 *
 *   Tier 1 — fan-out: any command that reaches more than one remote host in one
 *            shot (loops, xargs/parallel, ansible, pssh, several ssh calls).
 *            Confirmed regardless of what it does, because a read-only sweep
 *            and a destructive one look identical until it is too late.
 *
 *   Tier 2 — remote state change: a single ssh carrying a verb that changes
 *            service, network, boot or account state. One machine is
 *            recoverable, but these are the verbs an injection would chain.
 *
 * A single ssh running a read-only command (`hostname -I`, `curl ifconfig.me`)
 * is deliberately NOT confirmed: that is the operator's normal workflow, and a
 * guard that fires constantly gets approved reflexively, which is worse than no
 * guard at all.
 *
 * This is defence in depth, not a guarantee. A determined injection that stays
 * under these thresholds still gets through; the point is to remove the cheap
 * path from "one poisoned page" to "54 machines down".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rule {
	pattern: RegExp;
	desc: string;
}

/** Executing across many hosts in one command. */
const FAN_OUT: Rule[] = [
	{ pattern: /\bfor\b[\s\S]{0,120}\bdo\b[\s\S]{0,200}\bssh\b/, desc: "循环遍历主机执行 ssh" },
	{ pattern: /\bwhile\b[\s\S]{0,120}\bread\b[\s\S]{0,200}\bssh\b/, desc: "按行读取主机列表执行 ssh" },
	{ pattern: /\bxargs\b[^;&|]*\bssh\b/, desc: "xargs 批量 ssh" },
	{ pattern: /\bparallel\b[^;&|]*\bssh\b/, desc: "parallel 批量 ssh" },
	{ pattern: /\b(pssh|parallel-ssh|clush|pdsh|fabric|fab)\b/, desc: "并行 ssh 工具" },
	{ pattern: /\bansible(-playbook)?\b/, desc: "ansible 批量操作" },
	{ pattern: /\bkubectl\b[^;&|]*\b(delete|drain|cordon)\b/, desc: "kubectl 批量删除/驱逐" },
	{ pattern: /\bdocker\b[^;&|]*\b(prune|kill|rm)\b[^;&|]*(-a|--all)\b/, desc: "docker 全量清理" },
];

/** State-changing verbs that matter even on a single remote host. */
const REMOTE_STATE: Rule[] = [
	{ pattern: /\bsystemctl\b[^;&|]*\b(stop|disable|mask)\b/, desc: "停用服务" },
	{ pattern: /\b(reboot|shutdown|poweroff|halt)\b/, desc: "重启/关机" },
	{ pattern: /\biptables\b[^;&|]*\s-(F|X|Z)\b/, desc: "清空防火墙规则" },
	{ pattern: /\bnft\b[^;&|]*\bflush\b/, desc: "清空 nftables" },
	{ pattern: /\bufw\b[^;&|]*\bdisable\b/, desc: "关闭 ufw" },
	{ pattern: /\bcrontab\b[^;&|]*\s-r\b/, desc: "删除定时任务" },
	{ pattern: /\b(userdel|usermod|passwd)\b/, desc: "修改账户" },
	{ pattern: /\b(truncate|shred)\b/, desc: "截断/擦除文件" },
	{ pattern: />\s*\/etc\//, desc: "覆盖 /etc 下的配置" },
	{ pattern: /\bwg-quick\b[^;&|]*\bdown\b/, desc: "关闭 WireGuard" },
];

function countSsh(command: string): number {
	return (command.match(/\bssh\b/g) ?? []).length;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		if (!command) return undefined;

		const reasons: string[] = [];

		for (const { pattern, desc } of FAN_OUT) {
			if (pattern.test(command)) reasons.push(desc);
		}
		// Several ssh invocations chained in one command is fan-out even without
		// an explicit loop construct.
		if (reasons.length === 0 && countSsh(command) >= 3) reasons.push("同一条命令里多次 ssh");

		const touchesRemote = /\bssh\b/.test(command) || reasons.length > 0;
		if (touchesRemote) {
			for (const { pattern, desc } of REMOTE_STATE) {
				if (pattern.test(command)) reasons.push(desc);
			}
		}

		if (reasons.length === 0) return undefined;

		const summary = [...new Set(reasons)].join(" + ");

		// No UI means no way to ask, and an unattended fan-out is exactly the
		// scenario this exists to stop. Fail closed.
		if (!ctx.hasUI) {
			return { block: true, reason: `阻止批量/远程状态变更（${summary}），无法确认` };
		}

		const ok = await ctx.ui.confirm(`批量或远程变更：${summary}`, command.slice(0, 1200));
		if (!ok) return { block: true, reason: `已拒绝：${summary}` };
		return undefined;
	});
}
