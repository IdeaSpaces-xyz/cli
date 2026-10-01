import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { saveSpace } from "../auth/spaces.js";
import { loadMapNote } from "../local/map-note.js";
import { mapKindOf, resolveMapAddress } from "../local/map-resolve.js";
import { CHECKOUT_SEARCH_LIMIT, inspectSpaceMapRoots } from "../local/space-map.js";

const ID_RESEARCH = "n_111111111111111111111111";
const ID_OPS = "n_222222222222222222222222";
const ID_ROUTED = "n_333333333333333333333333";
const ID_ELSEWHERE = "n_0123456789abcdef01234567";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function repo(dir: string, agreement?: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  if (agreement) commit(dir, "_agent/agreement.md", agreement);
  return dir;
}

function commit(dir: string, path: string, content: string): string {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, ["add", path]);
  git(dir, ["commit", "-q", "-m", `write ${path}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function agreement(name: string, id: string): string {
  return `---\nname: ${name}\nroot_node_id: ${id}\n---\n# ${name}\n`;
}

function writeMap(home: string, file: string, roots: object[], members: object[] = []): string {
  const yaml = [
    "---",
    "name: Space",
    "map:",
    "  roots:",
    ...roots.flatMap((root) =>
      Object.entries(root).map(([key, value], index) => `${index ? "      " : "    - "}${key}: ${JSON.stringify(value)}`),
    ),
    members.length ? "  members:" : "  members: []",
    ...members.flatMap((member) =>
      Object.entries(member).map(([key, value], index) => `${index ? "      " : "    - "}${key}: ${JSON.stringify(value)}`),
    ),
    "---",
    "",
  ].join("\n");
  mkdirSync(join(home, file, ".."), { recursive: true });
  writeFileSync(join(home, file), yaml);
  return join(home, file);
}

// Every test builds several Git repositories; Windows process startup exceeds the 5s default.
describe("resolveMapAddress — one resolver reads a Map member", { timeout: 30_000 }, () => {
  let base: string;
  let home: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "is-map-resolve-")));
    home = join(base, "space");
    mkdirSync(home);
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    // The registry lives under HOME; never touch the real one.
    process.env.HOME = join(base, "user");
    mkdirSync(process.env.HOME);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(base, { recursive: true, force: true });
  });

  function spaceWithResearch() {
    const research = repo(join(home, "notes", "research"), agreement("Agreement — Research", ID_RESEARCH));
    const pin = commit(research, "frictions/x.md", "at pin\n");
    const head = commit(research, "frictions/x.md", "at head\n");
    const mapPath = writeMap(home, "space.map.md", [{ root_node_id: ID_RESEARCH, sha: pin }], [
      { root: 0, position: "frictions", depth: "summary" },
    ]);
    return { research, pin, head, map: loadMapNote(mapPath, home) };
  }

  it("reads pinned bytes at pin and HEAD with drift after the checkout moved on", () => {
    const { pin, head, map } = spaceWithResearch();

    const atPin = resolveMapAddress(map, `@${ID_RESEARCH}//frictions/x.md`, { at: "pin" });
    expect(atPin).toMatchObject({ status: "checkout_at_pin", commit: pin, content: "at pin\n", drift: true, rootIndex: 0 });

    const atHead = resolveMapAddress(map, `@${ID_RESEARCH}//frictions/x.md`, { at: "head" });
    expect(atHead).toMatchObject({ status: "checkout_at_head", commit: head, content: "at head\n", drift: true });
    expect(atHead.canonical).toBe(`@${ID_RESEARCH}//frictions/x.md`);
  });

  it("finds a checkout nested two folders below the Map, as a Space with grouped checkouts", () => {
    const { research } = spaceWithResearch();
    const [located] = inspectSpaceMapRoots(loadMapNote("space.map.md", home).map.roots, home);
    expect(located.checkoutPath).toBe(research);
    expect(located.status).toBe("moved");
  });

  it("defaults a Space Map to HEAD and a Thread Map to the pin", () => {
    const { pin } = spaceWithResearch();
    const space = loadMapNote("space.map.md", home);
    expect(mapKindOf(space.path)).toBe("space");
    expect(resolveMapAddress(space, `@${ID_RESEARCH}//frictions/x.md`)).toMatchObject({ at: "head", content: "at head\n" });

    const threadMap = writeMap(home, "_threads/t/_agent/maps/m.md", [{ root_node_id: ID_RESEARCH, sha: pin }]);
    const thread = loadMapNote(threadMap, home);
    expect(mapKindOf(thread.path)).toBe("thread");
    // A Thread Map's own folder is not where checkouts live; the caller names the context.
    expect(resolveMapAddress(thread, `@${ID_RESEARCH}//frictions/x.md`, { contextDir: home })).toMatchObject({
      at: "pin",
      content: "at pin\n",
    });
  });

  it("changes nothing for the caller when the checkout moves to another folder", () => {
    const { research, map } = spaceWithResearch();
    const before = resolveMapAddress(map, `@${ID_RESEARCH}//frictions/x.md`, { at: "pin" });
    mkdirSync(join(home, "elsewhere", "deeper"), { recursive: true });
    const moved = join(home, "elsewhere", "deeper", "renamed");
    renameSync(research, moved);
    const after = resolveMapAddress(map, `@${ID_RESEARCH}//frictions/x.md`, { at: "pin" });
    expect(after.content).toBe(before.content);
    expect(after.status).toBe(before.status);
    expect(after.checkoutPath).toBe(moved);
  });

  it("resolves from any working directory", () => {
    const { map } = spaceWithResearch();
    const elsewhere = join(base, "somewhere-else");
    mkdirSync(elsewhere);
    process.chdir(elsewhere);
    expect(resolveMapAddress(map, `@${ID_RESEARCH}//frictions/x.md`, { at: "pin" }).content).toBe("at pin\n");
  });

  it("answers to declared names, Agreement names and registry slugs", () => {
    const { pin } = spaceWithResearch();
    const ops = repo(join(home, "team", "ops"), agreement("Agreement — Ops", ID_OPS));
    const opsSha = git(ops, ["rev-parse", "HEAD"]);
    const routed = repo(join(home, "notes", "archive"));
    const routedSha = commit(routed, "README.md", "# Archive\n");
    git(routed, ["remote", "add", "origin", "https://git.ideaspaces.xyz/someone/archive-space.git"]);
    // The registry still holds the folder where it was before the move.
    saveSpace(join(base, "old", "archive-space"), {
      repo_id: "repo_f",
      slug: "archive-space",
      namespace: "someone",
      root_node_id: ID_ROUTED,
      route_status: "resolved",
      route_namespace: "someone",
      route_slug: "archive-space",
      canonical_path: `/repos/${ID_ROUTED}`,
    });
    const mapPath = writeMap(home, "space.map.md", [
      { root_node_id: ID_RESEARCH, sha: pin },
      { root_node_id: ID_OPS, sha: opsSha, name: "dispatch" },
      { root_node_id: ID_ROUTED, sha: routedSha },
    ]);
    const map = loadMapNote(mapPath, home);

    expect(resolveMapAddress(map, "@research//frictions/x.md", { at: "pin" })).toMatchObject({ rootIndex: 0, content: "at pin\n" });
    expect(resolveMapAddress(map, "@dispatch//_agent/agreement.md")).toMatchObject({ rootIndex: 1, status: "checkout_at_head" });
    // A declared name replaces the default one.
    expect(resolveMapAddress(map, "@ops//")).toMatchObject({ status: "invalid_address" });
    expect(resolveMapAddress(map, "@archive-space//README.md")).toMatchObject({
      rootIndex: 2,
      checkoutPath: routed,
      content: "# Archive\n",
    });
  });

  it("returns a directory's entries", () => {
    const { map } = spaceWithResearch();
    const result = resolveMapAddress(map, "@research//", { at: "pin" });
    expect(result.kind).toBe("directory");
    expect(result.entries).toEqual([
      { name: "_agent", type: "directory" },
      { name: "frictions", type: "directory" },
    ]);
  });

  it("reads the reader's own root with //", () => {
    const { research, map } = spaceWithResearch();
    process.chdir(research);
    expect(resolveMapAddress(map, "//frictions/x.md", { at: "pin" })).toMatchObject({ rootIndex: 0, content: "at pin\n" });
    process.chdir(base);
    expect(resolveMapAddress(map, "//frictions/x.md")).toMatchObject({ status: "invalid_address" });
  });

  it("reports what it cannot read as results, never exceptions", () => {
    const { research, pin } = spaceWithResearch();
    const absentPin = "f".repeat(40);
    const mapPath = writeMap(home, "space.map.md", [
      { root_node_id: ID_RESEARCH, sha: pin },
      { root_node_id: ID_ELSEWHERE, sha: pin },
      { root_node_id: ID_RESEARCH, sha: absentPin, name: "stale" },
    ]);
    const map = loadMapNote(mapPath, home);

    const unreachable = resolveMapAddress(map, `@${ID_ELSEWHERE}//x.md`);
    expect(unreachable.status).toBe("unreachable");
    expect(unreachable.reason).toContain(ID_ELSEWHERE);

    expect(resolveMapAddress(map, "@stale//frictions/x.md", { at: "pin" })).toMatchObject({
      status: "pin_absent",
      checkoutPath: research,
    });
    expect(resolveMapAddress(map, "@research//nope.md", { at: "pin" }).status).toBe("missing_path");
    expect(resolveMapAddress(map, "@n_ffffffffffffffffffffffff//x.md").status).toBe("invalid_address");
    // The same identity pinned twice is ambiguous by identity; its name still reaches it.
    expect(resolveMapAddress(map, `@${ID_RESEARCH}//x.md`).reason).toMatch(/more than one/);
    expect(resolveMapAddress(map, "frictions/x.md").status).toBe("invalid_address");
  });
  it("refuses a file over the read limit as a result", () => {
    const { map } = spaceWithResearch();
    expect(resolveMapAddress(map, "@research//frictions/x.md", { at: "pin", maxBytes: 3 })).toMatchObject({
      status: "too_large",
      reason: expect.stringContaining("read limit is 3"),
    });
  });

  it("stops at checkout boundaries, skips tooling folders, and searches three levels down", () => {
    const { pin } = spaceWithResearch();
    const id = (n: number) => `n_${String(n).repeat(24)}`;
    const shas: string[] = [];
    const place = (path: string, n: number) => {
      const dir = repo(join(home, path), agreement(`Agreement — R${n}`, id(n)));
      shas.push(git(dir, ["rev-parse", "HEAD"]));
    };
    place("notes/research/nested", 4); // inside another checkout: belongs to it
    place("node_modules/pkg", 5);
    place("a/b/c", 6); // three levels: found
    place("a/b/c2/d", 7); // four levels: not searched
    const mapPath = writeMap(home, "space.map.md", [
      { root_node_id: ID_RESEARCH, sha: pin },
      ...[4, 5, 6, 7].map((n, i) => ({ root_node_id: id(n), sha: shas[i] })),
    ]);
    const located = inspectSpaceMapRoots(loadMapNote(mapPath, home).map.roots, home);
    expect(located.map((root) => root.checkoutPath !== null)).toEqual([true, false, false, true, false]);
  });

  it("says when the folder search was capped", () => {
    const { pin } = spaceWithResearch();
    for (let i = 0; i <= CHECKOUT_SEARCH_LIMIT; i++) mkdirSync(join(home, `f${String(i).padStart(4, "0")}`));
    const mapPath = writeMap(home, "space.map.md", [
      { root_node_id: ID_RESEARCH, sha: pin },
      { root_node_id: ID_ELSEWHERE, sha: pin },
    ]);
    const result = resolveMapAddress(loadMapNote(mapPath, home), `@${ID_ELSEWHERE}//x.md`);
    expect(result.status).toBe("unreachable");
    expect(result.reason).toContain(`stopped after ${CHECKOUT_SEARCH_LIMIT} folders`);
  });

  it("reports two roots answering to one Agreement name as ambiguous", () => {
    const { pin } = spaceWithResearch();
    const twin = repo(join(home, "notes", "twin"), agreement("Agreement — Research", ID_OPS));
    const mapPath = writeMap(home, "space.map.md", [
      { root_node_id: ID_RESEARCH, sha: pin },
      { root_node_id: ID_OPS, sha: git(twin, ["rev-parse", "HEAD"]) },
    ]);
    const result = resolveMapAddress(loadMapNote(mapPath, home), "@research//");
    expect(result.status).toBe("invalid_address");
    expect(result.reason).toMatch(/more than one root by name/);
  });
});
