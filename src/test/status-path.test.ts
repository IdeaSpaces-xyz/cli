import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCommand } from "../commands/status.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: tmp, encoding: "utf-8" }).stdout.trim();
}

async function statusCapture(flags: Record<string, string | boolean>) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => {
    out += s;
    return true;
  };
  let exit: number;
  try {
    exit = await statusCommand.run([], flags, G);
  } finally {
    (process.stdout as any).write = orig;
  }
  return { exit, result: out ? JSON.parse(out) : null };
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-statuspath-")));
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

describe("ideaspaces status --path", () => {
  it("reports sha + flags for a staged new file", async () => {
    await fs.writeFile(join(tmp, "a.md"), "# A", "utf-8");
    git(["add", "a.md"]);
    const { exit, result } = await statusCapture({ path: "a.md" });
    expect(exit).toBe(0);
    expect(result).toMatchObject({
      path: "a.md",
      exists: true,
      sha: git(["hash-object", "a.md"]),
      in_index: true,
      in_tracked: true,
    });
  });

  it("reports a non-existent path", async () => {
    const { exit, result } = await statusCapture({ path: "ghost.md" });
    expect(exit).toBe(0);
    expect(result).toMatchObject({ path: "ghost.md", exists: false, sha: null, in_tracked: false });
  });

  it("resolves a bare filename against the cwd, not the repo root (subdir)", async () => {
    // File lives in a subdirectory; the agent is `cd`-ed into it and passes a
    // bare filename. It must resolve against the cwd, not the repo toplevel.
    await fs.mkdir(join(tmp, "sub"), { recursive: true });
    await fs.writeFile(join(tmp, "sub", "n.md"), "# N", "utf-8");
    git(["add", "sub/n.md"]);
    const here = process.cwd();
    process.chdir(join(tmp, "sub"));
    try {
      const { result } = await statusCapture({ path: "n.md" });
      expect(result.exists).toBe(true);
      expect(result.sha).toBe(git(["hash-object", "sub/n.md"]));
    } finally {
      process.chdir(here);
    }
  });

  it("flags an unstaged modification on a committed file", async () => {
    await fs.writeFile(join(tmp, "a.md"), "# A", "utf-8");
    git(["add", "a.md"]);
    git(["commit", "-q", "-m", "a"]);
    await fs.writeFile(join(tmp, "a.md"), "# A changed", "utf-8");
    const { result } = await statusCapture({ path: "a.md" });
    expect(result.modified).toBe(true);
    expect(result.in_tracked).toBe(true);
  });
});
