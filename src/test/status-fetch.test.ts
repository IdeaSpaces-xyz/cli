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

async function runStatus(cwd: string, flags: Record<string, string | boolean>) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: any) => ((out += s), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: any) => ((err += s), true);
  let exit: number;
  try {
    exit = await statusCommand.run([], flags, G);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
    process.chdir(origCwd);
  }
  return { exit, out, err };
}

async function statusJson(cwd: string, flags: Record<string, string | boolean>) {
  const { out } = await runStatus(cwd, flags);
  if (!out) throw new Error("status produced no stdout");
  return JSON.parse(out);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "is-status-fetch-"));
  const bare = join(root, "remote.git");
  const a = join(root, "a");
  const b = join(root, "b");

  git(root, ["init", "--bare", "-b", "main", bare]);
  git(root, ["clone", bare, a]);
  git(a, ["config", "user.email", "a@test"]);
  git(a, ["config", "user.name", "A"]);
  writeFileSync(join(a, "f.md"), "one\n");
  git(a, ["add", "."]);
  git(a, ["commit", "-m", "one"]);
  git(a, ["push", "-u", "origin", "main"]);
  // Second clone `b` starts at "one".
  git(root, ["clone", bare, b]);
  git(b, ["config", "user.email", "b@test"]);
  git(b, ["config", "user.name", "B"]);
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

    expect((await statusJson(b, {})).behind).toBe(0);
    expect((await statusJson(b, { fetch: true })).behind).toBe(1);
  });

  it("exits 1 with context when the fetch fails", async () => {
    const b = join(root, "b");
    git(b, ["remote", "set-url", "origin", "file:///does/not/exist.git"]);

    const { exit, err } = await runStatus(b, { fetch: true });

    expect(exit).toBe(1);
    expect(err).toContain("git fetch failed");
  });
});
