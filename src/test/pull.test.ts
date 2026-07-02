import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullCommand } from "../commands/pull.js";
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
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-pull-")));
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

/** Wire an upstream, advance it by one commit, then rewind local so `tmp` ends
 * up exactly one commit BEHIND origin/main. Returns the bare remote path and the
 * remote's head sha. */
async function makeBehindByOne(): Promise<{ bare: string; remoteHead: string }> {
  const bare = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-bare-")));
  spawnSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  git(["push", "-q", "-u", "origin", "main"]);

  // Commit + push (remote advances), then rewind local → local is behind by one.
  await fs.writeFile(join(tmp, "remote-note.md"), "# From remote", "utf-8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "remote note"]);
  const remoteHead = git(["rev-parse", "HEAD"]);
  git(["push", "-q", "origin", "main"]);
  git(["reset", "--hard", "HEAD~1"]);
  return { bare, remoteHead };
}

describe("ideaspaces pull", () => {
  it("--dry-run is non-mutating (HEAD unchanged)", async () => {
    const before = git(["rev-parse", "HEAD"]);
    const exit = await pullCommand.run([], { "dry-run": true }, G);
    expect(exit).toBe(0);
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("integrates remote commits when behind (happy path)", async () => {
    const { bare, remoteHead } = await makeBehindByOne();
    try {
      const exit = await pullCommand.run([], {}, G);
      expect(exit).toBe(0);
      // Local HEAD now contains the remote commit (rebased on top → same tip).
      expect(git(["rev-parse", "HEAD"])).toBe(remoteHead);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("never pushes — local-only commits stay local", async () => {
    const bare = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-bare-")));
    try {
      spawnSync("git", ["init", "-q", "--bare", bare]);
      git(["remote", "add", "origin", bare]);
      git(["push", "-q", "-u", "origin", "main"]);
      const remoteBefore = git(["--git-dir", bare, "rev-parse", "main"], bare);

      // One commit ahead locally.
      await fs.writeFile(join(tmp, "local.md"), "# Local", "utf-8");
      git(["add", "."]);
      git(["commit", "-q", "-m", "local"]);

      const exit = await pullCommand.run([], {}, G); // up to date to pull, nothing to push
      expect(exit).toBe(0);
      // Remote unchanged — pull must not push.
      expect(git(["--git-dir", bare, "rev-parse", "main"], bare)).toBe(remoteBefore);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("refuses to integrate while a staged capture is uncommitted", async () => {
    const { bare } = await makeBehindByOne();
    try {
      await fs.writeFile(join(tmp, "pending.md"), "# Pending", "utf-8");
      git(["add", "pending.md"]); // staged, uncommitted
      const exit = await pullCommand.run([], {}, G);
      expect(exit).toBe(1);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
