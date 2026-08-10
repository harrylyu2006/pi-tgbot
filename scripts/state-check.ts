import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-tg-state-check-"));
const path = join(dir, "state.json");
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
let failures = 0;
function ok(name: string, cond: boolean): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

console.log("模型和 reasoning 持久化：");
const first = new State(path, log);
first.load();
first.markSeen(42);
first.setAgentPreferences({ model: "custom/gpt-5.6-sol", thinkingLevel: "max" });
const stored = JSON.parse(readFileSync(path, "utf8"));
ok("写入 model", stored.agentPreferences?.model === "custom/gpt-5.6-sol");
ok("写入 thinkingLevel", stored.agentPreferences?.thinkingLevel === "max");
ok("保留已有 seen 状态", stored.seen?.includes(42));

const second = new State(path, log);
second.load();
ok("重启加载 model", second.agentPreferences.model === "custom/gpt-5.6-sol");
ok("重启加载 thinkingLevel", second.agentPreferences.thinkingLevel === "max");
second.setAgentPreferences({ thinkingLevel: "high" });
ok("单字段更新不覆盖 model", second.agentPreferences.model === "custom/gpt-5.6-sol");
ok("单字段更新 reasoning", second.agentPreferences.thinkingLevel === "high");

// Getter must not expose mutable internal state.
const snapshot = second.agentPreferences as { model?: string };
snapshot.model = "mutated/model";
ok("读取快照不能修改内部状态", second.agentPreferences.model === "custom/gpt-5.6-sol");

console.log(failures === 0 ? "\nSTATE CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
