import { IdleWatchdog } from "../src/agent/idle-watchdog.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
	if (!cond) failures++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

console.log("滑动空闲超时：");
{
	let fired = 0;
	const watchdog = new IdleWatchdog(50, () => fired++);
	watchdog.touch();
	await sleep(30);
	watchdog.touch();
	await sleep(30);
	ok("收到新活动后不按原始固定期限超时", fired === 0);
	await sleep(35);
	ok("最后一次活动后完整空闲窗口才超时", fired === 1);
}
{
	let fired = 0;
	const watchdog = new IdleWatchdog(35, () => fired++);
	watchdog.touch();
	await sleep(10);
	watchdog.stop();
	await sleep(45);
	ok("turn 结束后取消超时", fired === 0);
}
{
	let fired = 0;
	const watchdog = new IdleWatchdog(30, () => fired++);
	watchdog.touch();
	await sleep(10);
	watchdog.stop();
	watchdog.touch();
	await sleep(35);
	ok("旧 turn 的定时回调不会影响新 turn", fired === 1);
}

console.log(failures === 0 ? "\nIDLE WATCHDOG CHECK PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
