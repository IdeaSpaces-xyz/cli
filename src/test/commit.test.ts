import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionState } from "@ideaspaces/sdk";
import { commitCommand } from "../commands/commit.js";
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
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-commit-")));
  home = await mkdtemp(join(tmpdir(), "is-cli-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = home; // isolate SDK sessionState
  cwd = process.cwd();
  process.chdir(tmp);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
});

afterEach(async () => {
  process.chdir(cwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(tmp, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("ideaspaces commit", () => {
  it("refuses a bare commit with no paths", async () => {
    const exit = await commitCommand.run([], { m: "msg" }, G);
    expect(exit).toBe(1);
  });

  it("refuses without a message", async () => {
    await fs.writeFile(join(tmp, "a.md"), "x", "utf-8");
    const exit = await commitCommand.run(["a.md"], {}, G);
    expect(exit).toBe(1);
  });

  it("commits ONLY the named path, leaving unrelated staged work untouched", async () => {
    // The user has unrelated work staged.
    await fs.writeFile(join(tmp, "user-code.txt"), "user work", "utf-8");
    git(["add", "user-code.txt"]);
    // The capture.
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "Capture note" }, G);
    expect(exit).toBe(0);

    // The commit contains note.md and NOT user-code.txt.
    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(files).toEqual(["note.md"]);
    // user-code.txt is still staged, never swept into the capture commit.
    const staged = git(["diff", "--cached", "--name-only"]);
    expect(staged).toContain("user-code.txt");
  });

  it("--tracked commits the plugin's session-tracked paths and clears them", async () => {
    await fs.writeFile(join(tmp, "tracked.md"), "# Tracked", "utf-8");
    const store = sessionState(tmp);
    await store.recordStagedPath("tracked.md");

    const exit = await commitCommand.run([], { m: "session capture", tracked: true }, G);
    expect(exit).toBe(0);

    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(files).toEqual(["tracked.md"]);
    // Committed paths are dropped from the tracked set.
    expect(await sessionState(tmp).getStagedPaths()).toEqual([]);
  });

  it("refuses --tracked when nothing is tracked", async () => {
    const exit = await commitCommand.run([], { m: "x", tracked: true }, G);
    expect(exit).toBe(1);
  });
});
