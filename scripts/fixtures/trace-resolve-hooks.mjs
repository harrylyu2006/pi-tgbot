import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, next) {
	const blocked = process.env.BLOCK_KDBXWEB === "1" && /^kdbxweb(?:\/|$)/.test(specifier);
	if (blocked) {
		if (process.env.TRACE_RESOLVE_FILE) appendFileSync(process.env.TRACE_RESOLVE_FILE, "kdbxweb (blocked)\n");
		const err = new Error(`Cannot find package 'kdbxweb' imported from ${context.parentURL}`);
		err.code = "ERR_MODULE_NOT_FOUND";
		throw err;
	}
	const result = await next(specifier, context);
	const trace = process.env.TRACE_RESOLVE_FILE;
	if (trace) {
		// Record what was really resolved, not the (often relative) specifier.
		const m = /\/secrets\/([\w-]+\.ts)$/.exec(result.url);
		if (m) appendFileSync(trace, `secrets/${m[1]}\n`);
		else if (/\/node_modules\/kdbxweb\//.test(result.url)) appendFileSync(trace, "kdbxweb\n");
	}
	return result;
}
