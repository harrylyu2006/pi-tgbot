/**
 * Renderer safety check.
 *
 * The dangerous input is not a finished markdown document — it is every prefix
 * of one, because that is exactly what streaming sends. So the main test feeds
 * every prefix of a nasty document through the compiler and asserts the result
 * is something Telegram would accept: balanced tags, allowed tags only, no
 * stray angle brackets, within the size budget.
 */

import { closeOpenTags } from "../src/telegram/html.ts";
import { compileBlocks } from "../src/telegram/markdown.ts";
import { packBlocks, packTail } from "../src/telegram/chunk.ts";

const ALLOWED = new Set(["b", "i", "u", "s", "a", "code", "pre", "blockquote", "tg-spoiler"]);
const MAX = 3800;

let failures = 0;
function fail(msg: string, detail?: string): void {
	failures++;
	console.log(`  ✗ ${msg}`);
	if (detail) console.log(`      ${detail.slice(0, 300)}`);
}

/** Returns an error string if `html` would be rejected by Telegram. */
function validate(html: string): string | null {
	const stack: string[] = [];
	const re = /<(\/?)([a-zA-Z-]+)((?:\s[^<>]*)?)>/g;
	let m: RegExpExecArray | null;
	let consumed = "";
	let last = 0;
	while ((m = re.exec(html)) !== null) {
		consumed += html.slice(last, m.index);
		last = re.lastIndex;
		const name = (m[2] ?? "").toLowerCase();
		if (!ALLOWED.has(name)) return `disallowed tag <${name}>`;
		if (m[1] === "/") {
			if (stack.pop() !== name) return `unbalanced </${name}>`;
		} else {
			stack.push(name);
		}
	}
	consumed += html.slice(last);
	if (stack.length > 0) return `unclosed <${stack.join("><")}>`;
	// Outside tags, a bare < or > must have been escaped.
	if (/[<>]/.test(consumed)) return "unescaped angle bracket in text";
	return null;
}

const NASTY = `# 标题 with <script>alert(1)</script> & ampersand

普通段落，包含 **粗体**、*斜体*、\`inline code\`、~~删除线~~ 和 [链接](https://example.com/a?b=1&c=2)。

未闭合的 **粗体开始
下划线_不该配对_的情况 a_b_c snake_case_name

- 列表项一
- 列表项二 with \`code\`
  - 嵌套项
1. 有序一
2. 有序二

> 引用块第一行
> 第二行带 **粗体**

| 列 A | 列 B |
|------|------|
| 值 1 | 值 2 |
| 中文 | x |

\`\`\`python
def f(x):
    if x < 3 and x > 1:
        return "<tag> & stuff"
\`\`\`

---

结尾段落 with emoji 🎉 和一个裸 URL https://example.com/plain
`;

console.log("[1] every streaming prefix produces valid HTML");
let prefixFailures = 0;
for (let i = 1; i <= NASTY.length; i++) {
	const html = closeOpenTags(packTail(compileBlocks(NASTY.slice(0, i)), MAX));
	const err = validate(html);
	if (err) {
		prefixFailures++;
		if (prefixFailures <= 3) fail(`prefix len=${i}: ${err}`, html.slice(-200));
	}
	if (html.length > MAX + 200) {
		fail(`prefix len=${i}: body ${html.length} exceeds budget`);
		break;
	}
}
if (prefixFailures === 0) console.log(`  ✓ all ${NASTY.length} prefixes valid`);
else console.log(`  ✗ ${prefixFailures} invalid prefixes`);

console.log("[2] full document compiles and packs");
const blocks = compileBlocks(NASTY);
const chunks = packBlocks(blocks, MAX);
console.log(`  blocks=${blocks.length} chunks=${chunks.length}`);
for (const [i, c] of chunks.entries()) {
	const err = validate(c);
	if (err) fail(`chunk ${i}: ${err}`, c);
	if (c.length > MAX) fail(`chunk ${i} too long: ${c.length}`);
}

console.log("[3] oversized code block splits and stays valid");
const bigCode = "```js\n" + Array.from({ length: 600 }, (_, i) => `const line${i} = "x < y && z";`).join("\n") + "\n```";
const bigChunks = packBlocks(compileBlocks(bigCode), MAX);
console.log(`  chunks=${bigChunks.length}`);
for (const [i, c] of bigChunks.entries()) {
	const err = validate(c);
	if (err) fail(`bigcode chunk ${i}: ${err}`, c);
	if (c.length > MAX) fail(`bigcode chunk ${i} too long: ${c.length}`);
	if (!c.startsWith("<pre><code")) fail(`bigcode chunk ${i} lost its code wrapper`, c.slice(0, 80));
}

console.log("[3b] nested tag repair");
{
	const malformedNested = '<blockquote expandable><b>thinking</blockquote>';
	const repaired = closeOpenTags(malformedNested);
	if (repaired === malformedNested) console.log("  ✓ outer close removes stale inner tag from repair stack");
	else fail("outer close left a stale inner tag in the repair stack", repaired);
}

console.log("[4] expected renderings");
const cases: Array<[string, string]> = [
	["**b**", "<b>b</b>"],
	["*i*", "<i>i</i>"],
	["`c`", "<code>c</code>"],
	["# H", "<b>H</b>"],
	["a < b & c", "a &lt; b &amp; c"],
	["`a < b`", "<code>a &lt; b</code>"],
	["snake_case_here", "snake_case_here"],
	["[x](https://e.com)", '<a href="https://e.com">x</a>'],
	["**a `b` c**", "<b>a <code>b</code> c</b>"],
];
for (const [input, expected] of cases) {
	const got = compileBlocks(input).join("\n");
	if (got !== expected) fail(`${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

console.log(`\n${failures === 0 ? "RENDER CHECK PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
