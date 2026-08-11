// Report how far each declared consumer's pin sits behind this repo's HEAD.
//
// The failure this exists for is not a check going red. It is a question nobody
// asks: every consumer pins a commit, main moves, and nothing anywhere holds the
// relationship. `vendor-lock.json` does this inside the plugin; this does it one
// level up, across repos.
//
//   node scripts/check-consumers.mjs            report, exit 0
//   node scripts/check-consumers.mjs --strict   exit 1 if a tracked consumer is behind
//
// Reads pins through `gh`, so it needs an authenticated CLI and network. A
// consumer it cannot read is reported as unread — never as current. Silence
// about a consumer is the exact failure mode this file is answering, so an
// unreadable one is louder than a stale one, not quieter.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The pinned sha a consumer declares, or a reason we could not learn it. */
function readPin(consumer) {
  let raw;
  try {
    raw = sh("gh", ["api", `repos/${consumer.repo}/contents/${consumer.pin.file}`, "--jq", ".content"]);
  } catch (err) {
    const detail = String(err.stderr || err.message).split("\n")[0];
    return { error: `could not read ${consumer.pin.file} (${detail})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return { error: `${consumer.pin.file} is not JSON we can read` };
  }
  let node = parsed;
  for (const key of consumer.pin.path) {
    node = node?.[key];
    if (node === undefined) return { error: `no ${consumer.pin.path.join(".")} in ${consumer.pin.file}` };
  }
  // Either a bare sha (vendor-lock) or a `github:owner/repo#sha` spec.
  const sha = /^[0-9a-f]{40}$/i.test(node) ? node : node.split("#")[1];
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return { error: `pin is not a commit: ${node}` };
  return { sha };
}

/** How many commits this repo's HEAD is ahead of `sha`, or a reason we cannot tell. */
function distance(sha) {
  try {
    // A pin older than a shallow clone, or from a force-pushed branch, is not a
    // number we can report — say so rather than print 0.
    sh("git", ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    return { error: "commit not in this clone (fetch --unshallow, or the pin is gone)" };
  }
  return { behind: Number(sh("git", ["rev-list", "--count", `${sha}..HEAD`])) };
}

let consumers;
try {
  ({ consumers } = JSON.parse(readFileSync(join(root, "consumers.json"), "utf8")));
  if (!Array.isArray(consumers)) throw new Error("no `consumers` array");
} catch (err) {
  // The declaration failing to parse is the one case where reporting nothing is
  // right — but say which file and why, rather than a stack trace from a script
  // whose whole argument is that silence about a consumer is the bug.
  console.error(`consumers.json could not be read: ${err.message}`);
  process.exit(1);
}
const head = sh("git", ["rev-parse", "HEAD"]);
console.log(`this repo at ${head.slice(0, 9)}\n`);

let behindTracked = 0;
let unread = 0;

for (const consumer of consumers) {
  const label = `${consumer.repo}${consumer.tracked ? "" : "  (own flow)"}`;
  const pin = readPin(consumer);
  if (pin.error) {
    unread++;
    console.log(`  ?  ${label}\n     unread — ${pin.error}`);
    continue;
  }
  const d = distance(pin.sha);
  if (d.error) {
    unread++;
    console.log(`  ?  ${label}\n     pinned ${pin.sha.slice(0, 9)}, distance unknown — ${d.error}`);
    continue;
  }
  if (d.behind === 0) {
    console.log(`  ok ${label}  ${pin.sha.slice(0, 9)}`);
    continue;
  }
  if (consumer.tracked) behindTracked++;
  console.log(`  !  ${label}  ${pin.sha.slice(0, 9)} — ${d.behind} behind`);
  if (consumer.note) console.log(`     ${consumer.note}`);
}

const checked = consumers.length - unread;
console.log(`\n${checked}/${consumers.length} consumers read.`);
if (unread) console.log(`${unread} unread — treat as unknown, not current.`);

// Unread consumers fail strict mode too. A check that goes green while it could
// not see half its subjects is the shape this whole exercise came from.
if (strict && (behindTracked || unread)) process.exit(1);
