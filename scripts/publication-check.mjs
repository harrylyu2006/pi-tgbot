#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function walk(root = ".", dir = ".") {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = relative(root, join(root, dir, entry.name)).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".pi-subagents", "dist", "coverage"].includes(entry.name)) continue;
      files.push(...walk(root, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

let files;
try {
  files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).split("\0").filter(Boolean);
} catch {
  files = walk();
}

const denyNames = [
  /(^|\/)config\.json$/i,
  /(^|\/)config\.(?!example\.json$).+\.json$/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)models\.json$/i,
  /(^|\/)web-search\.json$/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)credentials/i,
  /(^|\/)secrets?\./i,
  /(^|\/)sessions?\//i,
  /(^|\/)inbox\//i,
  /(^|\/)\.pi-subagents\//i,
  /\.jsonl$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /\.bak(?:\.|$)/i,
];

const ignoredFiles = new Set(["scripts/publication-check.mjs"]);
const forbiddenExtensions = /\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic)$/i;

const patterns = [
  ["Telegram bot token", /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["AWS access key", /\bAKIA[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["credentialed URL", /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@]+:[^\s@]+@/gi],
];

// Deliberately fake fixtures used by redaction tests. They are safe and must
// stay testable without teaching the scanner to ignore an entire file.
const allowedFixtureLines = new Set([
  'must("bot token", "token 是 1234567890:AAFAKEfaketokenfortestingonly1234567", true);',
  'must("中转 key", "用 sk-FAKEKEYFORTESTINGONLY123456 连上去的", true);',
  'must("github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", true);',
  'must("私钥块", "-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----", true);',
  'must("数据库 URL", "postgres://user:hunter2@db.example.com/x", true);',
]);

const findings = [];
for (const file of files) {
  if (ignoredFiles.has(file)) continue;
  if (forbiddenExtensions.test(file)) findings.push(`${file}: image assets require explicit privacy review and are forbidden by default`);
  for (const rule of denyNames) {
    if (rule.test(file)) findings.push(`${file}: forbidden publication filename`);
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // Binary files are checked by filename; GitHub can scan their history.
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (file === "scripts/redact-check.ts" && allowedFixtureLines.has(line.trim())) continue;
    for (const [name, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
    }
  }
}

if (findings.length) {
  console.error("Publication check failed:\n" + findings.map((x) => `  - ${x}`).join("\n"));
  process.exit(1);
}

console.log(`Publication check passed (${files.length} files inspected).`);
