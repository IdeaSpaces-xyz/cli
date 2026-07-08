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

/** Capture the JSON on stdout and any error text on stderr. */
async function runNavigate(args: string[], flags: Record<string, string | boolean> = {}): Promise<any> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await navigateCommand.run(args, flags, G);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = origOut;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = origErr;
  }
  const stdout = out.join("");
  return { exit, data: stdout ? JSON.parse(stdout) : null, err: err.join("") };
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

  it("distinguishes a non-directory path from a missing one", async () => {
    const file = await runNavigate(["_agent/now.md"]);
    expect(file.exit).toBe(1);
    expect(file.err).toContain("Not a directory");
    const missing = await runNavigate(["does/not/exist"]);
    expect(missing.exit).toBe(1);
    expect(missing.err).toContain("No such path");
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

  it("renders the local catalog + working set when --workspace is given", async () => {
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-ws-")));
    try {
      const child = join(ws, "childrepo");
      await fs.mkdir(child, { recursive: true });
      git(["init", "-q", "-b", "main"], child);
      git(["config", "user.email", "t@e.com"], child);
      git(["config", "user.name", "T"], child);
      git(["commit", "-q", "-m", "seed", "--allow-empty"], child);
      const { data } = await runNavigate(["."], { workspace: ws });
      expect(data.text).toContain("Repos in scope (local):");
      expect(data.text).toContain("childrepo (local-only)");
      expect(data.text).toContain("Working set:");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("renders no catalog without --workspace (no cwd default)", async () => {
    const { data } = await runNavigate(["."]);
    expect(data.text).not.toContain("Repos in scope");
    expect(data.text).not.toContain("Working set:");
  });

  it("warns and skips the catalog when --workspace is not a readable directory", async () => {
    const { data } = await runNavigate(["."], { workspace: join(tmp, "does-not-exist") });
    expect(data.text).toContain("--workspace is not a readable directory");
    expect(data.text).not.toContain("Repos in scope");
  });

  it("renders the remote pullable tier from --pullable", async () => {
    // tmp has no child repos → the local tier is empty, so only the pullable
    // tier shows: the caller passes the list it fetched via `catalog`.
    const { data } = await runNavigate(["."], { workspace: tmp, pullable: "team:acme.com,notes:alice" });
    expect(data.text).toContain("Pullable (remote — not yet local):");
    expect(data.text).toContain("  team (acme.com)");
    expect(data.text).toContain("  notes (alice)");
  });

  it("--no-git suppresses the compact Git line (caller renders its own state)", async () => {
    const withGit = await runNavigate(["."]);
    expect(withGit.data.text).toContain("Git: branch main");
    const noGit = await runNavigate(["."], { "no-git": true });
    expect(noGit.data.text).not.toContain("Git:");
  });

  it("reports position relative to the space root outside a git repo", async () => {
    // A space with an _agent/ but NOT a git repo (tmpdir isn't under git).
    const nogit = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-nogit-")));
    try {
      await fs.mkdir(join(nogit, "_agent"), { recursive: true });
      await fs.writeFile(join(nogit, "_agent", "foundation.md"), "---\nname: f\n---\nF.\n");
      await fs.mkdir(join(nogit, "branch"), { recursive: true });
      const { data } = await runNavigate([join(nogit, "branch")]);
      expect(data.repoRoot).toBeNull();
      expect(data.root).toBe(nogit);
      // Must reflect the real position, not collapse to "." (the fixed bug).
      expect(data.position).toBe("branch");
      // The Position section renders outside git too (walkPathContext is fs-only);
      // no "repo:" line since there's no repo.
      expect(data.text).toContain("Position:");
      expect(data.text).toContain("cwd: branch");
      expect(data.text).not.toContain("repo:");
    } finally {
      await rm(nogit, { recursive: true, force: true });
    }
  });

  it("only persists the seen marker with --mark-seen", async () => {
    const ref = () => spawnSync("git", ["-C", tmp, "rev-parse", "--verify", "--quiet", "refs/ideaspaces/seen"], { encoding: "utf-8" }).stdout.trim();
    await runNavigate(["."]);
    expect(ref()).toBe(""); // read-only navigate leaves no marker
    await runNavigate(["."], { "mark-seen": true });
    expect(ref()).toBe(git(["rev-parse", "HEAD"]));
  });
});
