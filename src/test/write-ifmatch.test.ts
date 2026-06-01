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

/** Run write, capturing the JSON result from stdout. */
async function writeCapture(args: string[], flags: Record<string, string | boolean>) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => {
    out += s;
    return true;
  };
  let exit: number;
  try {
    exit = await writeCommand.run(args, flags, G);
  } finally {
    (process.stdout as any).write = orig;
  }
  return { exit, result: out ? JSON.parse(out) : null };
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-ifmatch-")));
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

describe("ideaspaces write — if_match optimistic concurrency", () => {
  it("returns the content sha on create, usable as the next if_match", async () => {
    const { exit, result } = await writeCapture(["a.md"], { content: "# A", name: "A" });
    expect(exit).toBe(0);
    expect(result.sha).toBe(git(["hash-object", "a.md"]));
  });

  it("updates when if_match matches — no --force needed", async () => {
    const first = await writeCapture(["a.md"], { content: "# A", name: "A" });
    const second = await writeCapture(["a.md"], {
      content: "# A v2",
      name: "A",
      "if-match": first.result.sha,
    });
    expect(second.exit).toBe(0);
    expect(second.result.sha).not.toBe(first.result.sha);
    expect(await fs.readFile(join(tmp, "a.md"), "utf-8")).toContain("# A v2");
  });

  it("refuses when if_match does not match the current content", async () => {
    await writeCapture(["a.md"], { content: "# A", name: "A" });
    const { exit } = await writeCapture(["a.md"], {
      content: "# clobber",
      name: "A",
      "if-match": "0000000000000000000000000000000000000000",
    });
    expect(exit).toBe(6);
    // The file is unchanged after a refused write.
    expect(await fs.readFile(join(tmp, "a.md"), "utf-8")).toContain("# A");
  });

  it("--force overrides an if_match mismatch", async () => {
    await writeCapture(["a.md"], { content: "# A", name: "A" });
    const { exit } = await writeCapture(["a.md"], {
      content: "# forced",
      name: "A",
      "if-match": "deadbeef",
      force: true,
    });
    expect(exit).toBe(0);
    expect(await fs.readFile(join(tmp, "a.md"), "utf-8")).toContain("# forced");
  });
});
