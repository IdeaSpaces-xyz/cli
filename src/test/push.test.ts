import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushCommand } from "../commands/push.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let home: string;
let cwd: string;
let prevHome: string | undefined;

function git(args: string[], dir = tmp): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-push-")));
  home = await mkdtemp(join(tmpdir(), "is-cli-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  cwd = process.cwd();
  process.chdir(tmp);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
  await fs.writeFile(join(tmp, "seed.md"), "seed", "utf-8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
});

afterEach(async () => {
  process.chdir(cwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(tmp, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("ideaspaces push", () => {
  it("--dry-run is non-mutating (no push, HEAD unchanged)", async () => {
    const before = git(["rev-parse", "HEAD"]);
    const exit = await pushCommand.run([], { "dry-run": true }, G);
    expect(exit).toBe(0);
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("refuses while staged captures are uncommitted (before any network)", async () => {
    await fs.writeFile(join(tmp, "pending.md"), "# Pending", "utf-8");
    git(["add", "pending.md"]);
    const exit = await pushCommand.run([], {}, G);
    expect(exit).toBe(1);
  });

  it("pushes local commits to the upstream (happy path)", async () => {
    const bare = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-bare-")));
    try {
      spawnSync("git", ["init", "-q", "--bare", bare]);
      git(["remote", "add", "origin", bare]);
      git(["push", "-q", "-u", "origin", "main"]);

      await fs.writeFile(join(tmp, "capture.md"), "# Capture", "utf-8");
      git(["add", "."]);
      git(["commit", "-q", "-m", "capture"]);
      const localHead = git(["rev-parse", "HEAD"]);

      const exit = await pushCommand.run([], {}, G);
      expect(exit).toBe(0);

      const remoteHead = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(remoteHead).toBe(localHead);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('refuses when behind ("pull first") and does not push', async () => {
    const bare = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-bare-")));
    try {
      spawnSync("git", ["init", "-q", "--bare", bare]);
      git(["remote", "add", "origin", bare]);
      git(["push", "-q", "-u", "origin", "main"]);

      // Advance the remote then rewind local → local is behind by one.
      await fs.writeFile(join(tmp, "remote.md"), "# Remote", "utf-8");
      git(["add", "."]);
      git(["commit", "-q", "-m", "remote"]);
      git(["push", "-q", "origin", "main"]);
      const remoteHead = git(["--git-dir", bare, "rev-parse", "main"], bare);
      git(["reset", "--hard", "HEAD~1"]);

      // Add a divergent local commit → diverged (behind wins: pull first).
      await fs.writeFile(join(tmp, "local.md"), "# Local", "utf-8");
      git(["add", "."]);
      git(["commit", "-q", "-m", "local"]);

      const exit = await pushCommand.run([], {}, G);
      expect(exit).toBe(1);
      // Remote unchanged — refused, nothing pushed.
      expect(git(["--git-dir", bare, "rev-parse", "main"], bare)).toBe(remoteHead);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
