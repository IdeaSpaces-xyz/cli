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

/** Capture stdout bytes and any error text; parse stdout in JSON mode. */
async function runNavigate(
  args: string[],
  flags: Record<string, string | boolean> = {},
  global: GlobalFlags = G,
): Promise<any> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await navigateCommand.run(args, flags, global);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = origOut;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = origErr;
  }
  const stdout = out.join("");
  return {
    exit,
    data: global.json && stdout ? JSON.parse(stdout) : null,
    stdout,
    err: err.join(""),
  };
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
  it("renders the protocol Position bytes and preserves the output newline", async () => {
    const expectedPosition = [
      "Position:",
      `  repo: ${tmp}`,
      "  cwd: .",
      "  space root: .",
      "  active _agent: .",
    ].join("\n");

    const { exit, data, stdout } = await runNavigate(["."]);
    expect(exit).toBe(0);
    expect(data.position).toBe(".");
    expect(data.root).toBe(tmp);
    expect(data.repoRoot).toBe(tmp);
    expect(data.text.split("\n\n")[0]).toBe(expectedPosition);
    expect(data.text).toContain("Now:");
    expect(stdout.endsWith("\n")).toBe(true);

    const human = await runNavigate(["."], {}, { ...G, json: false });
    expect(human.stdout.startsWith(`${expectedPosition}\n\n`)).toBe(true);
    expect(human.stdout.endsWith("\n")).toBe(true);
  });

  it("tracks position when navigating into a subdir (fractal contract from root)", async () => {
    await fs.mkdir(join(tmp, "sub"), { recursive: true });
    await fs.writeFile(join(tmp, "sub", "note.md"), "# Note\n");
    const { data } = await runNavigate(["sub"]);
    // The subdir has no _agent of its own, so the contract composes from the
    // root space — root stays the space root, position moves.
    expect(data.position).toBe("sub");
    expect(data.root).toBe(tmp);
    expect(data.text.split("\n\n")[0]).toBe(
      [
        "Position:",
        `  repo: ${tmp}`,
        "  cwd: sub",
        "  space root: .",
        "  active _agent: .",
      ].join("\n"),
    );
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

  it("renders the catalog + hint at a bare workspace folder (no _agent contract)", async () => {
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-bare-")));
    try {
      const child = join(ws, "childrepo");
      await fs.mkdir(child, { recursive: true });
      git(["init", "-q", "-b", "main"], child);
      git(["config", "user.email", "t@e.com"], child);
      git(["config", "user.name", "T"], child);
      git(["commit", "-q", "-m", "seed", "--allow-empty"], child);
      // ws has no _agent and isn't itself a git repo → a bare workspace folder.
      const { data } = await runNavigate([ws], { workspace: ws });
      expect(data.root).toBeNull(); // no contract resolves
      expect(data.text).toContain("Repos in scope (local):");
      expect(data.text).toContain("childrepo (local-only)");
      expect(data.text).toContain("Navigate into a repo below"); // the bare-folder hint
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("nudges to clone at an empty bare workspace folder (no repos yet)", async () => {
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-empty-")));
    try {
      // A fresh workspace folder — no child repos, no _agent, not a git repo.
      const { data } = await runNavigate([ws], { workspace: ws });
      expect(data.root).toBeNull();
      expect(data.text).not.toContain("Repos in scope"); // nothing to list
      expect(data.text).toContain("no repos yet"); // the empty-folder hint, not "navigate into a repo below"
      expect(data.text).not.toContain("Navigate into a repo below");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
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
      // The protocol Position renderer works outside git too; no repo line.
      expect(data.text.split("\n\n")[0]).toBe(
        [
          "Position:",
          "  cwd: branch",
          "  space root: .",
          "  active _agent: .",
        ].join("\n"),
      );
    } finally {
      await rm(nogit, { recursive: true, force: true });
    }
  });

  it("exposes the structured manifest in the JSON envelope", async () => {
    const { data } = await runNavigate(["."]);
    expect(data.manifest).toMatchObject({ kind: "content", spaceRoot: tmp });
    expect(data.manifest.contract.map((e: { name: string }) => e.name)).toContain("foundation");
    // Bare path carries an explicit null, not an absent field.
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-mf-")));
    try {
      const bare = await runNavigate([ws]);
      expect(bare.data.manifest).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("shows the full contract stack and inherited skills at a branch", async () => {
    await fs.mkdir(join(tmp, "_agent", "skills"), { recursive: true });
    await fs.writeFile(
      join(tmp, "_agent", "skills", "review.md"),
      "---\nname: review\nsummary: Root review procedure.\n---\nR.\n",
    );
    await fs.mkdir(join(tmp, "branch", "_agent"), { recursive: true });
    await fs.writeFile(
      join(tmp, "branch", "_agent", "guide.md"),
      "---\nname: guide\nsummary: Branch guide.\n---\nG.\n",
    );
    const { data } = await runNavigate(["branch"]);
    // Branch-level contract entries are annotated with their composing level.
    expect(data.text).toContain("guide (branch/) — Branch guide.");
    // A root skill reaches the branch — inherited along the path, where the
    // legacy block showed nothing at a position without its own _agent/skills.
    expect(data.text).toContain("review — Root review procedure.");
  });

  it("keeps the map tier between the stable block and the drift tail", async () => {
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-nav-order-")));
    try {
      const child = join(ws, "childrepo");
      await fs.mkdir(child, { recursive: true });
      git(["init", "-q", "-b", "main"], child);
      git(["config", "user.email", "t@e.com"], child);
      git(["config", "user.name", "T"], child);
      git(["commit", "-q", "-m", "seed", "--allow-empty"], child);
      const { data } = await runNavigate(["."], { workspace: ws });
      const t: string = data.text;
      // Disclosure ladder: stable block → map tier (handles) → drift tail.
      expect(t.indexOf("Working set:")).toBeGreaterThan(t.indexOf("Now:"));
      expect(t.indexOf("Repos in scope (local):")).toBeGreaterThan(t.indexOf("Working set:"));
      expect(t.indexOf("Git: branch")).toBeGreaterThan(t.indexOf("Repos in scope (local):"));
    } finally {
      await rm(ws, { recursive: true, force: true });
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
