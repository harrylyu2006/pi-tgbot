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
  // KeePass / vault data must never be publishable, except the fake fixtures.
  git("reset", "-q");
  writeFileSync(join(root, "safe.txt"), "safe source\n");
  git("add", ".gitignore", "safe.txt", "scripts/publication-check.mjs");
  mkdirSync(join(root, "scripts/fixtures"), { recursive: true });
  writeFileSync(join(root, "scripts/fixtures/fake.kdbx"), "fake fixture");
  writeFileSync(join(root, "passwords.kdbx"), "real database");
  mkdirSync(join(root, "vault"));
  writeFileSync(join(root, "vault/vault.json"), "{}");
  writeFileSync(join(root, "main.kdbx.prev"), "previous generation");
  writeFileSync(join(root, "main.kdbx.meta.json"), "{}");
  assert.equal(scan().status, 0, "databases and vault files are ignored by default, fixtures excepted");
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n");
  assert(listed.includes("scripts/fixtures/fake.kdbx"), "fixture databases stay publishable");
  for (const f of ["passwords.kdbx", "vault/vault.json", "main.kdbx.prev", "main.kdbx.meta.json"]) {
    assert(!listed.includes(f), `${f} must be ignored`);
    git("add", "-f", f);
    const r = scan("--staged");
    assert.equal(r.status, 1, `force-added ${f} must fail the staged scan`);
    assert(r.stderr.includes(f) && !r.stderr.includes("real database"), "names the file, never its contents");
    git("reset", "-q", "--", f);
  }
  git("add", "-f", "scripts/fixtures/fake.kdbx");
  assert.equal(scan("--staged").status, 0, "the fake fixtures pass");
  mkdirSync(join(root, "scripts/fixtures/sub"), { recursive: true });
  writeFileSync(join(root, "scripts/fixtures/sub/nested.kdbx"), "x");
  git("add", "-f", "scripts/fixtures/sub/nested.kdbx");
  assert.equal(scan("--staged").status, 1, "only files directly in scripts/fixtures are allowed, not nested ones");
  git("reset", "-q", "--", "scripts/fixtures/sub/nested.kdbx");
  writeFileSync(join(root, "scripts/fixtures/fake.kdbx.bak"), "x");
  git("add", "-f", "scripts/fixtures/fake.kdbx.bak");
  assert.equal(scan("--staged").status, 1, "backup/previous copies next to fixtures are still refused");
  console.log("Publication regressions passed: ignored local data, forced private config, staged blob isolation, KeePass/vault file blocking, and secret-free diagnostics.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
