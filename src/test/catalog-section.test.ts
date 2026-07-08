import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCatalogSection, formatWorkingSetSection, MAX_CATALOG_REPOS } from "../catalog.js";

// Golden-lock for the catalog/working-set render (decision D of pi→CLI
// convergence): the strings are lifted verbatim from pi-is-space, so these
// snapshots must match pi's output byte-for-byte, making the step-3 swap
// provable. A drift here fails the test instead of a user's awareness block.

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

// A real, committed local-only repo (no upstream, clean tree) → "local-only".
async function makeRepo(ws: string, name: string, summary?: string): Promise<string> {
  const dir = join(ws, name);
  await mkdir(dir, { recursive: true });
  if (summary) {
    await mkdir(join(dir, "_agent"), { recursive: true });
    await writeFile(join(dir, "_agent", "now.md"), `---\nname: ${name}\nsummary: ${summary}\n---\n# ${name}\n`);
  }
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed", "--allow-empty"]);
  return dir;
}

describe("formatCatalogSection", () => {
  let ws: string;
  beforeEach(async () => {
    ws = realpathSync(await mkdtemp(join(tmpdir(), "is-catalog-")));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("renders repos with sync state, summary, and POV/mounted tags — priority first", async () => {
    await makeRepo(ws, "alpha", "Alpha notes");
    const beta = await makeRepo(ws, "beta"); // POV, no summary
    const gamma = await makeRepo(ws, "gamma", "Gamma work"); // mounted
    await mkdir(join(ws, "docs")); // a plain dir — not a repo, excluded

    const out = await formatCatalogSection(ws, { povRepoRoot: beta, mounts: [gamma] });
    expect(out).toBe(
      [
        "Repos in scope (local):",
        "  beta (local-only · POV)",
        "  gamma — Gamma work (local-only · mounted)",
        "  alpha — Alpha notes (local-only)",
      ].join("\n"),
    );
  });

  it("returns null when the folder holds no child repos", async () => {
    await mkdir(join(ws, "docs"));
    await writeFile(join(ws, "note.md"), "# not a repo\n");
    expect(await formatCatalogSection(ws, { povRepoRoot: null, mounts: [] })).toBeNull();
  });

  it("renders the pullable tier, and omits its header when empty (no dangling header)", async () => {
    await makeRepo(ws, "alpha");
    const withPull = await formatCatalogSection(ws, {
      povRepoRoot: null,
      mounts: [],
      pullable: [{ slug: "team", namespace: "acme.com" }],
    });
    expect(withPull).toContain("Pullable (remote — not yet local):");
    expect(withPull).toContain("  team (acme.com)");
    expect(withPull).toContain("`ideaspaces clone`");

    const noPull = await formatCatalogSection(ws, { povRepoRoot: null, mounts: [], pullable: [] });
    expect(noPull).not.toContain("Pullable"); // decision C porter check
  });

  it("caps at MAX_CATALOG_REPOS and summarises the overflow", async () => {
    // Fake `.git` dirs are enough to be counted as repos (state resolves to
    // "unknown"); real git per repo would only slow the cap check.
    for (let i = 0; i < MAX_CATALOG_REPOS + 1; i++) {
      await mkdir(join(ws, `r${String(i).padStart(2, "0")}`, ".git"), { recursive: true });
    }
    const out = await formatCatalogSection(ws, { povRepoRoot: null, mounts: [] });
    const lines = out!.split("\n");
    expect(lines[0]).toBe("Repos in scope (local):");
    expect(lines.filter((l) => l.startsWith("  r")).length).toBe(MAX_CATALOG_REPOS);
    expect(lines[lines.length - 1]).toBe("  …and 1 more");
  });
});

describe("formatWorkingSetSection", () => {
  let ws: string;
  beforeEach(async () => {
    ws = realpathSync(await mkdtemp(join(tmpdir(), "is-ws-")));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("renders home + mount handles with summary and dir count", async () => {
    const home = join(ws, "home");
    await mkdir(join(home, "_agent"), { recursive: true });
    await writeFile(join(home, "_agent", "now.md"), "---\nname: h\nsummary: Home space\n---\n");
    await mkdir(join(home, "sub1"));
    await mkdir(join(home, "sub2")); // dirs: _agent, sub1, sub2 → 3

    const mount = join(ws, "mnt");
    await mkdir(join(mount, "_agent"), { recursive: true });
    await writeFile(join(mount, "_agent", "now.md"), "---\nsummary: Mounted repo\n---\n");

    const out = await formatWorkingSetSection(home, [mount]);
    expect(out).toBe(
      [
        "Working set:",
        "  home: home — Home space (3 dirs)",
        `  mount: ${mount} — Mounted repo (1 dirs)`,
      ].join("\n"),
    );
  });
});
