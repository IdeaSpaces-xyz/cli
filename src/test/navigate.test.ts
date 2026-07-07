import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navigateCommand } from "../commands/navigate.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;

function git(args: string[], dir = tmp): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Capture the JSON object navigateCommand writes to stdout. */
async function runNavigate(args: string[], flags: Record<string, string | boolean> = {}): Promise<any> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((s: string) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  let exit: number;
  try {
    exit = await navigateCommand.run(args, flags, G);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = orig;
  }
  return { exit, data: JSON.parse(chunks.join("")) };
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-navigate-")));
  cwd = process.cwd();
  process.chdir(tmp);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
  await fs.mkdir(join(tmp, "_agent"), { recursive: true });
  await fs.writeFile(join(tmp, "_agent", "foundation.md"), "---\nname: f\n---\nFoundation.\n");
  await fs.writeFile(join(tmp, "_agent", "now.md"), "---\nname: now\n---\nShipping the navigate command.\n");
  await fs.writeFile(join(tmp, "_agent", "purpose.md"), "---\nname: p\n---\nWhy we exist.\n");
  await fs.writeFile(join(tmp, "README.md"), "# Space\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces navigate", () => {
  it("orients at the root: text + position + root + repoRoot", async () => {
    const { exit, data } = await runNavigate(["."]);
    expect(exit).toBe(0);
    expect(data.position).toBe(".");
    expect(data.root).toBe(tmp);
    expect(data.repoRoot).toBe(tmp);
    expect(data.text).toContain("Now:");
    expect(data.text).toContain("Position:");
  });

  it("tracks position when navigating into a subdir (fractal contract from root)", async () => {
    await fs.mkdir(join(tmp, "sub"), { recursive: true });
    await fs.writeFile(join(tmp, "sub", "note.md"), "# Note\n");
    const { data } = await runNavigate(["sub"]);
    // The subdir has no _agent of its own, so the contract composes from the
    // root space — root stays the space root, position moves.
    expect(data.position).toBe("sub");
    expect(data.root).toBe(tmp);
  });

  it("refuses a non-directory path", async () => {
    const { exit } = await runNavigate(["_agent/now.md"]).catch(() => ({ exit: 1 }));
    expect(exit).toBe(1);
  });

  it("surfaces missing-direction drift when purpose/now are absent", async () => {
    await rm(join(tmp, "_agent", "now.md"));
    await rm(join(tmp, "_agent", "purpose.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "drop direction"]);
    const { data } = await runNavigate(["."]);
    expect(data.text).toContain("`_agent/now.md` not yet captured");
    expect(data.text).toContain("`_agent/purpose.md` not yet captured");
  });

  it("only persists the seen marker with --mark-seen", async () => {
    const ref = () => spawnSync("git", ["-C", tmp, "rev-parse", "--verify", "--quiet", "refs/ideaspaces/seen"], { encoding: "utf-8" }).stdout.trim();
    await runNavigate(["."]);
    expect(ref()).toBe(""); // read-only navigate leaves no marker
    await runNavigate(["."], { "mark-seen": true });
    expect(ref()).toBe(git(["rev-parse", "HEAD"]));
  });
});
