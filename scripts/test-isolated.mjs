// `npm test`: one isolated Vitest run, safe beside another run on the same machine and beside the app.
//
// Each run gets a new root, /tmp/is-run-XXXXXX (short, so a Unix socket path under it stays below
// macOS's 104-byte limit), holding its own HOME, temp folder, XDG folders and an empty Git config
// pair. The person's session variables are cleared (scripts/test-isolation-env.mjs). Every temporary
// Space a test makes lands under that root, and the root is removed when the run ends, pass, fail or
// Ctrl-C. A root left by a run that was killed outright is removed by the next run, once its pid is
// gone. Tests bind port 0 (src/test/test-isolation.test.ts refuses a fixed port). Some tests run the
// built bundle/ideaspaces.js, so a run warns when src/ is newer than it. So a full run takes no
// heavy-test lock (How we ship, "One Mac, shared", 2026-11-20).
//
// As before, the real Git config files are checked after the run, and a run that changed them fails.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "./test-isolation-env.mjs";

const base = process.platform === "win32" ? tmpdir() : "/tmp";
const PREFIX = "is-run-";

const realFiles = [...new Set([
  process.env.GIT_CONFIG_GLOBAL || join(process.env.HOME || process.env.USERPROFILE || tmpdir(), ".gitconfig"),
  process.env.GIT_CONFIG_SYSTEM || "/etc/gitconfig",
])];
const digest = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Only roots this runner made (its prefix and its pid file), and only once that pid is gone.
function removeDeadRoots() {
  let names = [];
  try { names = readdirSync(base).filter((name) => name.startsWith(PREFIX)); } catch { return; }
  for (const name of names) {
    const root = join(base, name);
    let pid;
    try { pid = Number(readFileSync(join(root, "pid"), "utf8").trim()); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* someone else's turn */ }
  }
}

// Tests that run bundle/ideaspaces.js (hosted-threads, map-edit, workspace-files) test whatever was
// last built. CI builds it in `npm ci`; a person's checkout may be behind their own edits.
function newestSource(dir) {
  let newest = { path: "", mtime: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const inner = newestSource(path); if (inner.mtime > newest.mtime) newest = inner; }
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      const mtime = statSync(path).mtimeMs;
      if (mtime > newest.mtime) newest = { path, mtime };
    }
  }
  return newest;
}
if (!process.env.CI && existsSync("bundle/ideaspaces.js") && existsSync("src")) {
  const newest = newestSource("src");
  if (newest.mtime > statSync("bundle/ideaspaces.js").mtimeMs + 1000) {
    console.warn(`Warning: ${newest.path} is newer than bundle/ideaspaces.js. The tests that run the bundle will test the old build. Run \`npm run build\` first.`);
  }
}

removeDeadRoots();
const before = realFiles.map(digest);
// Its real path (/private/tmp on macOS), so a test comparing realpath() with tmpdir() sees one folder.
const root = realpathSync(mkdtempSync(join(base, PREFIX)));
writeFileSync(join(root, "pid"), `${process.pid}\n`);
const env = isolatedEnv(process.env, root);

const child = spawn(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "run", ...process.argv.slice(2)], { stdio: "inherit", env });
let stopping = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { stopping = signal; child.kill(signal); });
}
child.on("exit", (code, signal) => {
  let status = code ?? 1;
  if (signal || stopping) status = 130;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  catch (error) { console.error(`Test run could not remove its root ${root}: ${error.message}`); }
  const changed = realFiles.filter((path, index) => digest(path) !== before[index]);
  if (changed.length) {
    console.error(`Test run changed real Git configuration: ${changed.join(", ")}`);
    status = 1;
  }
  process.exit(status);
});
child.on("error", (error) => {
  console.error(`Test run could not start Vitest: ${error.message}`);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
