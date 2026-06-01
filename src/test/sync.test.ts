import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionState } from "@ideaspaces/sdk";
import { syncCommand } from "../commands/sync.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let home: string;
let cwd: string;
let prevHome: string | undefined;

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-sync-")));
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

describe("ideaspaces sync", () => {
  it("--dry-run is non-mutating (no commit/push, HEAD unchanged)", async () => {
    const before = git(["rev-parse", "HEAD"]);
    const exit = await syncCommand.run([], { "dry-run": true }, G);
    expect(exit).toBe(0);
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("refuses to sync while plugin-tracked captures are uncommitted", async () => {
    await sessionState(tmp).recordStagedPath("pending.md");
    const exit = await syncCommand.run([], {}, G);
    expect(exit).toBe(1); // refuses before touching the network
  });
});
