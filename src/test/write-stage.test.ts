import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCommand } from "../commands/write.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: tmp, encoding: "utf-8" }).stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-write-stage-")));
  cwd = process.cwd();
  process.chdir(tmp);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "T"], { cwd: tmp });
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces write — staging", () => {
  it("stages the written file by default, but does not commit", async () => {
    const exit = await writeCommand.run(
      ["notes/a.md"],
      { content: "# A", name: "A" },
      G,
    );
    expect(exit).toBe(0);
    // Staged (in the index)...
    expect(git(["diff", "--cached", "--name-only"])).toContain("notes/a.md");
    // ...but no commit was made.
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });

  it("--stage=false writes without staging", async () => {
    const exit = await writeCommand.run(
      ["notes/b.md"],
      { content: "# B", name: "B", stage: "false" },
      G,
    );
    expect(exit).toBe(0);
    expect(await fs.readFile(join(tmp, "notes/b.md"), "utf-8")).toContain("# B");
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
  });
});
