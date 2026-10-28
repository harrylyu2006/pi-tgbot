import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-tg-publication-test-"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const scan = (...args) => spawnSync(process.execPath, [join(root, "scripts/publication-check.mjs"), ...args], { cwd: root, encoding: "utf8" });
try {
  git("init", "-q");
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL("./publication-check.mjs", import.meta.url)), join(root, "scripts/publication-check.mjs"));
  copyFileSync(fileURLToPath(new URL("../.gitignore", import.meta.url)), join(root, ".gitignore"));
  writeFileSync(join(root, "safe.txt"), "safe source\n");
  git("add", ".gitignore", "safe.txt", "scripts/publication-check.mjs");
  const fakeKey = ["sk", "T".repeat(36)].join("-");
  writeFileSync(join(root, "config.json"), JSON.stringify({ key: fakeKey }));
  mkdirSync(join(root, "node_modules.old-test"));
  writeFileSync(join(root, "node_modules.old-test", "private.txt"), fakeKey);
  assert.equal(scan().status, 0, "ignored runtime data/dependency backups are not publication candidates");
  git("add", "-f", "config.json");
  const rejected = scan("--staged");
  assert.equal(rejected.status, 1, "force-added private config must fail");
  assert(!rejected.stderr.includes(fakeKey), "diagnostics must not echo secret values");
  git("rm", "--cached", "-f", "config.json");
  writeFileSync(join(root, "safe.txt"), fakeKey);
  git("add", "safe.txt");
  writeFileSync(join(root, "safe.txt"), "safe working copy\n");
  assert.equal(scan("--staged").status, 1, "scan the staged blob, not a cleaned working copy");
  git("add", "safe.txt");
  writeFileSync(join(root, "safe.txt"), fakeKey);
  assert.equal(scan("--staged").status, 0, "unstaged changes are not part of the staged commit");
  assert.equal(scan().status, 1, "default scan still catches dirty working-copy secrets");
  console.log("Publication regressions passed: ignored local data, forced private config, staged blob isolation, and secret-free diagnostics.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
