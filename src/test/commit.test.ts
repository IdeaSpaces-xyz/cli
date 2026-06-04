import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCommand } from "../commands/commit.js";
import { writeCommand } from "../commands/write.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-commit-")));
  cwd = process.cwd();
  process.chdir(tmp);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(tmp, { recursive: true, force: true });
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

  it("--all commits staged ideaspace paths and leaves staged code uncommitted", async () => {
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent/now.md"), "now", "utf-8");
    await fs.writeFile(join(tmp, "app.ts"), "code", "utf-8");
    git(["add", "note.md", "_agent/now.md", "app.ts"]);

    const exit = await commitCommand.run([], { m: "save knowledge", all: true }, G);
    expect(exit).toBe(0);

    const committed = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
    expect(committed).toEqual(["_agent/now.md", "note.md"]);
    // The staged code file is left for the user — still staged, not committed.
    expect(git(["diff", "--cached", "--name-only"])).toContain("app.ts");
  });

  it("--all refuses when only non-ideaspace files are staged", async () => {
    await fs.writeFile(join(tmp, "app.ts"), "code", "utf-8");
    git(["add", "app.ts"]);
    expect(await commitCommand.run([], { m: "x", all: true }, G)).toBe(1);
  });

  it("--all refuses when nothing is staged", async () => {
    expect(await commitCommand.run([], { m: "x", all: true }, G)).toBe(1);
  });

  it("rejects combining --all with explicit paths", async () => {
    await fs.writeFile(join(tmp, "a.md"), "x", "utf-8");
    git(["add", "a.md"]);
    expect(await commitCommand.run(["a.md"], { m: "x", all: true }, G)).toBe(1);
  });

  it("write stages a path; commit --all saves it (no session ledger)", async () => {
    // Writing through the CLI stages the file in git...
    const w = await writeCommand.run(["note.md"], { content: "# Note", name: "Note" }, G);
    expect(w).toBe(0);
    expect(git(["diff", "--cached", "--name-only"])).toContain("note.md");

    // ...so commit --all finds it straight from the index — no session state.
    const c = await commitCommand.run([], { m: "save", all: true }, G);
    expect(c).toBe(0);
    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(files).toEqual(["note.md"]);
  });
});
