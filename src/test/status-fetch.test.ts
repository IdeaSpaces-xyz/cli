import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCommand } from "../commands/status.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function statusJson(cwd: string, flags: Record<string, string | boolean>) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: any) => {
    out += s;
    return true;
  };
  try {
    await statusCommand.run([], flags, G);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = orig;
    process.chdir(origCwd);
  }
  return JSON.parse(out);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "is-status-fetch-"));
  const bare = join(root, "remote.git");
  const a = join(root, "a");

  git(root, ["init", "--bare", "-b", "main", bare]);
  git(root, ["clone", bare, a]);
  git(a, ["config", "user.email", "a@test"]);
  git(a, ["config", "user.name", "A"]);
  writeFileSync(join(a, "f.md"), "one\n");
  git(a, ["add", "."]);
  git(a, ["commit", "-m", "one"]);
  git(a, ["push", "-u", "origin", "main"]);
  // Second clone `b` starts at "one".
  git(root, ["clone", bare, join(root, "b")]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("status --fetch", () => {
  it("sees new remote commits only after fetching", async () => {
    const a = join(root, "a");
    const b = join(root, "b");

    // A pushes a new commit; B's remote-tracking is now stale.
    writeFileSync(join(a, "f.md"), "two\n");
    git(a, ["commit", "-am", "two"]);
    git(a, ["push"]);

    const stale = await statusJson(b, {});
    expect(stale.behind).toBe(0);

    const fresh = await statusJson(b, { fetch: true });
    expect(fresh.behind).toBe(1);
  });
});
