import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCommand } from "../commands/map.js";
import { createThread } from "../local/threads.js";

// The Space's own Map derived from what is here, by type, against the hand-kept Map file; and a
// search over the Space answered as a Map. A Space with repositories two levels down, as Home keeps
// them, one of them not in the curated Map and one listed there but absent here.
vi.mock("../auth/credentials.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/credentials.js")>()), peekConfig: () => null, loadConfig: () => null }));
vi.mock("../auth/spaces.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/spaces.js")>()), loadSpaces: () => ({}) }));

// Root identities are 24 hex characters; a readable prefix maps to one.
const HEX: Record<string, string> = { home: "a1", scout: "b2", thoughts: "c3", gone: "d4" };
const ID = (n: string) => `n_${HEX[n].padEnd(24, "0")}`;
let root: string;
let cwd: string;
const originalHome = process.env.HOME;

function git(dir: string, ...args: string[]): string { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }
function repo(dir: string, agreement: string, files: Record<string, string> = {}): void {
  mkdirSync(join(dir, "_agent"), { recursive: true });
  writeFileSync(join(dir, "_agent", "agreement.md"), agreement);
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), content); }
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.email", "space@example.test"); git(dir, "config", "user.name", "Space Test");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
}
async function run(args: string[], flags: Record<string, string | boolean>, dir: string, json = true) {
  process.chdir(dir);
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  let out = ""; let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    const code = await mapCommand.run(args, flags, { json, quiet: true, yes: false, help: false });
    return { code, out, err, json: json && out.trim() ? JSON.parse(out) : undefined };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "is-map-repos-"))); cwd = process.cwd(); process.env.HOME = root;
  repo(root, `---\nname: Agreement — Home\nsummary: The Space.\nagreement: knowledge:repo:${ID("home")}\nroot_node_id: ${ID("home")}\n---\n# Home\n`, {
    "notes/why.md": "---\nname: Why\nsummary: Why we explore.\n---\n# Why\n\nProgressive closure is the work.\n",
  });
  repo(join(root, "agents", "scout"), `---\nname: Agreement — Scout\nsummary: Scout walks the gaps.\nagreement: agent:repo:${ID("scout")}\nroot_node_id: ${ID("scout")}\n---\n# Scout\n`, {
    "memory/lesson.md": "---\nname: A lesson\nsummary: Search the Threads before designing.\n---\n# Lesson\n\nProgressive closure, again.\n",
  });
  repo(join(root, "knowledge", "thoughts"), `---\nname: Agreement — Thoughts\nsummary: What we think.\nagreement: knowledge:repo:${ID("thoughts")}\nroot_node_id: ${ID("thoughts")}\n---\n# Thoughts\n`);
  const thoughts = createThread("2026-10-22-listening", "Listening", join(root, "knowledge", "thoughts"));
  writeFileSync(join(thoughts.path, "2026-10-22-opening.md"), "---\nid: msg_listening\ndate: 2026-10-22T10:00:00.000Z\nkind: post\nname: Listening\nsummary: Progressive closure for listening.\n---\n\nBody.\n");
  // A repository with no kind line and no identity, left uncommitted: the walk still finds it.
  const loose = join(root, "clients", "loose");
  mkdirSync(join(loose, "_agent"), { recursive: true });
  writeFileSync(join(loose, "_agent", "agreement.md"), "---\nname: Agreement — Loose\nsummary: A client's space.\n---\n# Loose\n");
  git(loose, "init", "-q", "-b", "main");
  // The curated Map lists Home, Scout, and one root that is not here.
  writeFileSync(join(root, "home.map.md"), `---\nname: Home\nsummary: The Space.\nmap:\n  roots:\n    - root_node_id: ${ID("home")}\n      sha: ${git(root, "rev-parse", "HEAD")}\n    - root_node_id: ${ID("scout")}\n      sha: ${git(join(root, "agents", "scout"), "rev-parse", "HEAD")}\n    - root_node_id: ${ID("gone")}\n      sha: ${"a".repeat(40)}\n  members: []\n---\n`);
});
afterEach(() => { process.chdir(cwd); process.env.HOME = originalHome; rmSync(root, { recursive: true, force: true }); });

describe("ideaspaces map --kind repos", () => {
  it("lists every repository here by type with its facts, against the curated Map", async () => {
    const result = await run(["."], { kind: "repos" }, root);
    expect(result.code, result.err).toBe(0);
    const space = result.json;
    expect(space.schema).toBe("ideaspaces.map.repos.v1");
    expect(space.repos.map((r: { label: string; kind: string | null }) => [r.label, r.kind])).toEqual([[".", "knowledge"], ["agents/scout", "agent"], ["clients/loose", null], ["knowledge/thoughts", "knowledge"]]);
    expect(space.by_kind).toEqual({ knowledge: 2, agent: 1, untyped: 1 });
    const byLabel = Object.fromEntries(space.repos.map((r: { label: string }) => [r.label, r]));
    // Home's uncommitted: the Map file, and the three nested repositories Git sees as untracked folders (no .gitignore here).
    expect(byLabel["."]).toMatchObject({ root: 0, name: "Home", summary: "The Space.", root_node_id: ID("home"), origin: null, uncommitted: 4, threads: null, in_map: true });
    expect(byLabel["agents/scout"]).toMatchObject({ name: "Scout", root_node_id: ID("scout"), in_map: true, uncommitted: 0 });
    expect(byLabel["knowledge/thoughts"]).toMatchObject({ threads: 1, in_map: false });
    expect(byLabel["clients/loose"]).toMatchObject({ kind: null, root_node_id: null, sha: null, in_map: false });
    expect(space.curated).toMatchObject({ file: "home.map.md", roots: 3, missing_here: [ID("gone")], not_listed: ["clients/loose", "knowledge/thoughts"] });
    // One repository has no identity and no HEAD: the Map carries the other three and names it beside them.
    expect(space.map_status).toBe("partial");
    expect(space.unidentified).toEqual(["clients/loose"]);
    expect(space.map.roots).toHaveLength(3);
    expect(space.map.members.map((m: { root: number }) => m.root)).toEqual([0, 1, 2]);
    expect(space.warnings.some((w: string) => w.includes("clients/loose"))).toBe(true);
    const text = await run(["."], { kind: "repos" }, root, false);
    expect(text.out).toContain("Space — ");
    expect(text.out).toContain("knowledge:");
    expect(text.out).toContain("[1] agents/scout  Scout · " + ID("scout"));
    expect(text.out).toContain("not in the curated Map");
    expect(text.out).toContain(`listed but not here: ${ID("gone")}; here but not listed: clients/loose, knowledge/thoughts`);
    expect(text.out).toContain("Map: partial: the identified repositories are pinned at HEAD; without identity or HEAD, standing outside it: clients/loose");
    // Without the loose repository every root is identified and pinned: a portable Map, one member per root at its root.
    rmSync(join(root, "clients"), { recursive: true, force: true });
    const portable = (await run(["."], { kind: "repos" }, root)).json;
    expect(portable.map_status).toBe("available");
    expect(portable.map.roots.map((r: { root_node_id: string; name: string }) => [r.root_node_id, r.name])).toEqual([[ID("home"), expect.any(String)], [ID("scout"), "scout"], [ID("thoughts"), "thoughts"]]);
    expect(portable.map.members.map((m: { root: number; position: string; depth: string }) => [m.root, m.position, m.depth])).toEqual([[0, ".", "summary"], [1, ".", "summary"], [2, ".", "summary"]]);
    expect((await run(["."], { kind: "repos", depth: "summary" }, root)).err).toContain("omit --depth");
    expect((await run(["."], { kind: "repos", levels: "1" }, root)).err).toContain("belongs to --kind threads");
  }, 60_000);

  it("answers a search over the Space as a Map of the hits, with the hits it has when a repository lacks identity", async () => {
    // With the unidentified repository present, the answer still comes: its hits stay in results, it is named beside the Map.
    writeFileSync(join(root, "clients", "loose", "note.md"), "# Loose\n\nProgressive closure here too.\n");
    const partial = await run(["."], { query: "progressive closure" }, root);
    expect(partial.code, partial.err).toBe(0);
    expect(partial.json.map_status).toBe("partial");
    expect(partial.json.unidentified).toEqual(["clients/loose"]);
    expect(partial.json.results.map((hit: { root: string }) => hit.root)).toContain("clients/loose");
    expect(partial.json.members).toHaveLength(3);
    expect(partial.json.hits_outside_map).toBe(1);
    expect(partial.json.map.roots).toHaveLength(3);
    rmSync(join(root, "clients"), { recursive: true, force: true });
    const result = await run(["."], { query: "progressive closure" }, root);
    expect(result.code, result.err).toBe(0);
    const found = result.json;
    expect(found.schema).toBe("ideaspaces.map.query.v1");
    expect(found.query).toBe("progressive closure");
    expect(found.results.map((hit: { root: string; path: string }) => `${hit.root}:${hit.path}`).sort()).toEqual([
      ".:notes/why.md", "agents/scout:memory/lesson.md", "knowledge/thoughts:_threads/2026-10-22-listening/2026-10-22-opening.md",
    ]);
    expect(found.members).toHaveLength(3);
    expect(found.members.every((m: { depth: string }) => m.depth === "summary")).toBe(true);
    expect(found.map_status).toBe("available");
    expect(found.unidentified).toEqual([]);
    expect(found.hits_outside_map).toBe(0);
    expect(found.map.roots).toHaveLength(3);
    expect(found.roots.map((r: { label: string; listed: number }) => r.label)).toEqual([".", "agents/scout", "knowledge/thoughts"]);
    const limited = (await run(["."], { query: "progressive closure", limit: "1" }, root)).json;
    expect(limited.results).toHaveLength(1);
    expect(limited.total).toBe(1);
    const text = await run(["."], { query: "closure kind:post" }, root, false);
    expect(text.out).toContain('Search — "closure kind:post" under ');
    expect(text.out).toContain("[2] _threads/2026-10-22-listening/2026-10-22-opening.md");
    expect((await run(["."], { query: "" }, root)).err).toContain("--query needs words");
    expect((await run(["."], { query: "x", kind: "threads" }, root)).err).toContain("omit --kind");
    expect((await run(["."], { query: "x", limit: "0" }, root)).err).toContain("--limit takes a whole number");
    expect((await run(["."], { limit: "3" }, root)).err).toContain("belongs to --kind threads");
  }, 60_000);

  it("reads a Thread root that is a folder inside a larger repository: uncommitted paths keep their slug", async () => {
    // A Space whose root is not its own repository: the start is a subfolder of the Home repository.
    const space = join(root, "clients", "inside");
    rmSync(join(root, "clients", "loose"), { recursive: true, force: true });
    mkdirSync(join(space, "_agent"), { recursive: true });
    writeFileSync(join(space, "_agent", "agreement.md"), "---\nname: Agreement — Inside\nsummary: Inside the larger repo.\n---\n# Inside\n");
    const t = createThread("2026-11-01-inner", "Inner", space);
    writeFileSync(join(t.path, "2026-11-01-opening.md"), "---\nid: msg_inner\ndate: 2026-11-01T10:00:00.000Z\nkind: post\nauthor: Someone\nname: Inner\n---\n\nBody.\n");
    const tree = (await run([space], { kind: "threads", problems: true }, root)).json;
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]).toMatchObject({ label: ".", threads: 1, uncommitted: 3 });
    expect(tree.uncommitted.map((u: { slug: string; path: string }) => `${u.slug}:${u.path}`).sort()).toEqual([
      "2026-11-01-inner:_threads/2026-11-01-inner/2026-11-01-opening.md", "2026-11-01-inner:_threads/2026-11-01-inner/README.md", "2026-11-01-inner:_threads/2026-11-01-inner/_agent/agreement.md",
    ]);
    expect(tree.problems.filter((p: { code: string }) => p.code === "uncommitted").map((p: { slug: string }) => p.slug)).toEqual(["2026-11-01-inner"]);
  }, 60_000);
});
