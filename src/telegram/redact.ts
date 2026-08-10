/**
 * Outbound redaction: scrub secrets on their way *out* to Telegram.
 *
 * This is the mirror image of the upstream `filter-output` extension, which
 * scrubs tool results on the way *in* to the model. Inbound scrubbing is right
 * when the worry is secrets reaching a third-party LLM; it is wrong here,
 * because the operator's own tasks (SSH into their fleet) require the model to
 * read credentials it has been given.
 *
 * The exposure that actually matters for this deployment is the chat log: it
 * lives on a phone, syncs to Telegram's servers, and is scrolled in public. So
 * the model may see secrets, and the transcript may not.
 *
 * Applied to model output only. Harness text is ours and contains no secrets.
 */

interface Rule {
	pattern: RegExp;
	replacement: string;
}

const RULES: Rule[] = [
	{ pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, replacement: "[KEY_REDACTED]" },
	{ pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g, replacement: "[KEY_REDACTED]" },
	{ pattern: /\b(sk-or-v1-[a-zA-Z0-9_-]{20,})\b/g, replacement: "[KEY_REDACTED]" },
	{ pattern: /\b(AIza[a-zA-Z0-9_-]{30,})\b/g, replacement: "[GOOGLE_KEY_REDACTED]" },
	{ pattern: /\b(gh[pousr]_[a-zA-Z0-9]{36,})\b/g, replacement: "[GITHUB_TOKEN_REDACTED]" },
	{ pattern: /\b(glpat-[a-zA-Z0-9_-]{20,})\b/g, replacement: "[GITLAB_TOKEN_REDACTED]" },
	{ pattern: /\b(npm_[a-zA-Z0-9]{20,})\b/g, replacement: "[NPM_TOKEN_REDACTED]" },
	{ pattern: /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g, replacement: "[SLACK_TOKEN_REDACTED]" },
	{ pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "[AWS_KEY_REDACTED]" },
	{ pattern: /\b(cf(?:k|ut|at)_[a-zA-Z0-9_-]{41,})\b/g, replacement: "[CLOUDFLARE_TOKEN_REDACTED]" },
	// Telegram bot tokens: this daemon's own credential, trivially exfiltrated
	// by asking the model to print its config.
	{ pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, replacement: "[BOT_TOKEN_REDACTED]" },
	{ pattern: /\b(bearer)\s+([a-zA-Z0-9._-]{20,})\b/gi, replacement: "Bearer [REDACTED]" },
	{ pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, replacement: "[JWT_REDACTED]" },
	{ pattern: /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:\s]+:)[^@\s]+(@)/gi, replacement: "$1[REDACTED]$2" },
	{
		pattern: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
		replacement: "[PRIVATE_KEY_REDACTED]",
	},
	// Generic assignments. Kept last and deliberately narrower than the upstream
	// extension's: it must not eat prose like "password: 见上表".
	{
		// The lookbehind keeps code readable: `const password = getPassword();` is
		// a declaration the operator asked to see, not a leaked credential.
		pattern: /(?<!\b(?:const|let|var|def|self)\s{0,4})\b(password|passwd|pwd|secret|api[_-]?key|apikey|token)\s*[=:]\s*(['"]?)([^\s'"，。;()]{8,})\2/gi,
		replacement: "$1=[REDACTED]",
	},
];

export interface RedactionResult {
	text: string;
	count: number;
}

export function redactOutbound(text: string): RedactionResult {
	let out = text;
	let count = 0;
	for (const { pattern, replacement } of RULES) {
		const before = out;
		out = out.replace(pattern, replacement);
		if (out !== before) count++;
	}
	return { text: out, count };
}
