// Keep tests from writing the app session's Git configuration, even when a fixture
// changes HOME. Check the inherited real files after the child exits (including failures).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFiles = [...new Set([
  process.env.GIT_CONFIG_GLOBAL || join(process.env.HOME || tmpdir(), ".gitconfig"),
  process.env.GIT_CONFIG_SYSTEM || "/etc/gitconfig",
])];
const digest = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
const before = realFiles.map(digest);
const root = mkdtempSync(join(tmpdir(), "is-vitest-git-"));
const global = join(root, "global.gitconfig"), system = join(root, "system.gitconfig");
writeFileSync(global, ""); writeFileSync(system, "");
let status = 1;
try {
  const child = spawnSync(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "run", ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: system },
  });
  status = child.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
  const changed = realFiles.filter((path, index) => digest(path) !== before[index]);
  if (changed.length) {
    console.error(`Test run changed real Git configuration: ${changed.join(", ")}`);
    status = 1;
  }
}
process.exitCode = status;
