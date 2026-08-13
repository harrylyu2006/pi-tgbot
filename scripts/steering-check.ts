import { steerIfStreaming } from "../src/agent/incoming.ts";

let failures = 0;
function ok(name: string, condition: boolean): void {
	if (!condition) failures++;
	console.log(`  ${condition ? "✓" : "✗"} ${name}`);
}

console.log("运行中消息 steering：");
{
	const received: string[] = [];
	const steered = await steerIfStreaming(
		{
			isStreaming: true,
			async steer(text: string) {
				received.push(text);
			},
		},
		"先别部署，改成只读检查",
	);
	ok("运行中消息进入当前 agent run", steered);
	ok("消息正文原样传给 Pi steer", received[0] === "先别部署，改成只读检查");
}

{
	let called = false;
	const steered = await steerIfStreaming(
		{
			isStreaming: false,
			async steer() {
				called = true;
			},
		},
		"下一条消息",
	);
	ok("空闲时不误用 steer", !steered);
	ok("空闲时由普通 prompt 路径接管", !called);
}

console.log(failures === 0 ? "\nSTEERING CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
