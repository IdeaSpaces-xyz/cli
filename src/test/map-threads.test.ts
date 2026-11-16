import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCommand } from "../commands/map.js";
import { createThread } from "../local/threads.js";

// A Space with a Thread tree the way UI/UX's 2026-11-14 audit found Home: a root Thread, children,
// a grandchild open under a closed parent, a second open root, an unresolved parent, a Thread named
// by a move, one with no holder, a nested repository with its own _threads/ hanging from the root's
// post, and files Git has not committed. Names and ids are synthetic.
vi.mock("../auth/credentials.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/credentials.js")>()), peekConfig: () => null, loadConfig: () => null }));
vi.mock("../auth/spaces.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/spaces.js")>()), loadSpaces: () => ({}) }));

const temp: string[] = [];
const originalHome = process.env.HOME;
let cwd: string;
beforeEach(() => { cwd = process.cwd(); });
afterEach(() => { process.chdir(cwd); process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z" } }).trim();
}
function repo(dir: string): void {
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.email", "tree@example.test"); git(dir, "config", "user.name", "Tree Test");
}
function post(dir: string, file: string, id: string, extra = "", body = "Body.") {
  writeFileSync(join(dir, file), `---\nid: ${id}\ndate: ${file.slice(0, 10)}T10:00:00.000Z\n${/^kind:/m.test(extra) ? "" : "kind: post\n"}${extra}---\n\n${body}\n`);
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

function space() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-map-threads-"))); temp.push(root);
  process.env.HOME = root;
  repo(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Space\nsummary: Space terms.\n---\n# Space\n");
  // The root Thread, opened by a named author (so it has a holder), with a post the children hang from.
  const spine = createThread("2026-09-30-spine", "Spine", root);
  post(spine.path, "2026-09-30-opening.md", "msg_spine_open", "author: Steward\nname: Spine\nsummary: The trunk.\n");
  post(spine.path, "2026-10-01-direction.md", "msg_spine_direction", "in_reply_to: msg_spine_open\nauthor: Steward\nname: Direction\n");
  // A child under the Spine's direction post, closed, with a grandchild still open under it.
  const closed = createThread("2026-10-05-closed-track", "Closed track", root);
  post(closed.path, "2026-10-05-opening.md", "msg_closed_open", "parent: post:msg_spine_direction\nattached_to: post:msg_spine_direction\nauthor: Scout\nname: Closed track\n");
  post(closed.path, "2026-10-20-closure.md", "msg_closed_end", "kind: closure\nclosed: true\nin_reply_to: msg_closed_open\nauthor: Scout\n", "Done.");
  const grand = createThread("2026-10-10-grandchild", "Grandchild", root);
  post(grand.path, "2026-10-10-opening.md", "msg_grand_open", "attached_to: post:msg_closed_open\nauthor: Scout\nname: Grandchild\n");
  // An open child whose README names nobody and whose opening has no author: no holder.
  const quiet = createThread("2026-10-12-quiet", "Quiet", root);
  post(quiet.path, "2026-10-12-opening.md", "msg_quiet_open", "parent: post:msg_spine_open\nname: Quiet\n");
  // A second open root: nothing above it.
  const loose = createThread("2026-10-15-loose", "Loose", root);
  post(loose.path, "2026-10-15-opening.md", "msg_loose_open", "author: Backend\nname: Loose\n");
  // A parent that names a post nobody has.
  const orphan = createThread("2026-10-18-orphan", "Orphan", root);
  post(orphan.path, "2026-10-18-opening.md", "msg_orphan_open", "attached_to: post:msg_missing\nauthor: Backend\nname: Orphan\n");
  // A Thread moved by the old writer: its reframe carries the "Moved under …" title 0.33.0 reads as the name.
  const moved = createThread("2026-10-20-moved", "Moved", root);
  post(moved.path, "2026-10-20-opening.md", "msg_moved_open", "attached_to: post:msg_spine_open\nauthor: UI/UX\nname: Moved\n");
  post(moved.path, "2026-11-13-reframe.md", "msg_moved_reframe", "kind: reframe\nin_reply_to: msg_moved_open\nauthor: UI/UX\nname: Moved under 2026-09-30-spine\nsummary: Current parent none → msg_spine_direction.\n", "Reattached this Thread.\n\n- Previous parent: none\n");
  writeFileSync(join(moved.path, "_agent", "agreement.md"), "---\nname: Agreement — Moved\nsummary: Terms.\nattached_to: msg_spine_direction\n---\n# Moved\n");
  // A repository inside the Space with its own _threads/, hanging from the Spine's opening by id.
  const nested = join(root, "knowledge", "notes");
  mkdirSync(nested, { recursive: true });
  repo(nested);
  mkdirSync(join(nested, "_agent"));
  writeFileSync(join(nested, "_agent", "agreement.md"), "---\nname: Agreement — Notes\nsummary: Notes terms.\n---\n# Notes\n");
  const far = createThread("2026-10-22-far", "Far", nested);
  post(far.path, "2026-10-22-opening.md", "msg_far_open", "attached_to: post:msg_spine_open\nauthor: Scout\nname: Far\n");
  git(nested, "add", "-A"); git(nested, "commit", "-q", "-m", "notes");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "space");
  // After the commit: one post the holder has not committed, and one Thread that only exists on disk.
  post(spine.path, "2026-11-14-uncommitted.md", "msg_spine_new", "in_reply_to: msg_spine_open\nauthor: Steward\nname: Newest\n");
  const fresh = createThread("2026-11-15-fresh", "Fresh", root);
  post(fresh.path, "2026-11-15-opening.md", "msg_fresh_open", "parent: post:msg_spine_direction\nattached_to: post:msg_spine_direction\nauthor: d-pm\nname: Fresh\n");
  return { root, nested };
}

describe("ideaspaces map --kind threads", () => {
  it("maps the whole tree in one call: every root, parents across repositories, levels and the six problems", async () => {
    const { root } = space();
    const result = await run(["."], { kind: "threads", levels: "all", depth: "name", problems: true }, root);
    expect(result.code, result.err).toBe(0);
    const tree = result.json;
    expect(tree.schema).toBe("ideaspaces.map.threads.v1");
    expect(tree.roots.map((r: { label: string; threads: number }) => [r.label, r.threads])).toEqual([[".", 8], ["knowledge/notes", 1]]);
    // Open roots are Threads with no parent at all; the orphan's parent is unresolved, which is its own problem, not a second root.
    expect(tree.counts).toMatchObject({ roots: 2, threads: 9, open: 8, closed: 1, listed: 9, open_roots: 2 });
    const bySlug = Object.fromEntries(tree.members.map((m: { slug: string }) => [m.slug, m]));
    expect(bySlug["2026-09-30-spine"]).toMatchObject({ level: 1, parent: null, parent_status: "none", children: 5, holder: "Steward", name: "Spine" });
    expect(bySlug["2026-10-05-closed-track"]).toMatchObject({ level: 2, closed: true, parent: { id: "msg_spine_direction", slug: "2026-09-30-spine", root: 0 } });
    expect(bySlug["2026-10-10-grandchild"]).toMatchObject({ level: 3, closed: false, parent: { slug: "2026-10-05-closed-track" } });
    // The nested repository's Thread hangs from the Spine's post, resolved across roots.
    expect(bySlug["2026-10-22-far"]).toMatchObject({ root: 1, level: 2, parent: { id: "msg_spine_open", slug: "2026-09-30-spine", root: 0 } });
    expect(bySlug["2026-10-20-moved"]).toMatchObject({ name: "Moved under 2026-09-30-spine", name_source: "reframe", parent: { id: "msg_spine_direction" } });
    expect(bySlug["2026-10-18-orphan"]).toMatchObject({ level: 1, parent: null, parent_status: "unresolved" });
    // Depth-first, siblings by slug: the Spine first, then its children in order, each child's children before the next sibling.
    expect(tree.members.map((m: { slug: string }) => m.slug).slice(0, 4)).toEqual(["2026-09-30-spine", "2026-10-05-closed-track", "2026-10-10-grandchild", "2026-10-12-quiet"]);
    const problems = Object.fromEntries(Object.keys(tree.definitions).map((code) => [code, tree.problems.filter((p: { code: string }) => p.code === code).map((p: { slug: string }) => p.slug)]));
    expect(problems).toEqual({
      "open-under-closed": ["2026-10-10-grandchild"],
      "extra-root": ["2026-10-15-loose"],
      "parent-unresolved": ["2026-10-18-orphan"],
      "no-holder": ["2026-10-12-quiet"],
      "moved-title": ["2026-10-20-moved"],
      "uncommitted": ["2026-09-30-spine", "2026-11-15-fresh"],
    });
    expect(tree.uncommitted.map((u: { path: string; status: string }) => `${u.status} ${u.path}`).sort()).toEqual([
      "?? _threads/2026-09-30-spine/2026-11-14-uncommitted.md",
      "?? _threads/2026-11-15-fresh/2026-11-15-opening.md",
      "?? _threads/2026-11-15-fresh/README.md",
      "?? _threads/2026-11-15-fresh/_agent/agreement.md",
    ]);
    expect(tree.roots[0].uncommitted).toBe(4);
    // Nothing of the test machine's identity: the fixture roots are not registered, so the Map is pending, members stand.
    expect(tree.map_status).toBe("projection_pending");
    expect(tree.map).toBeNull();
    expect(tree.definitions["extra-root"]).toContain("first such Thread in slug order");
    // About 70 bytes a Thread at the name rung.
    expect(Buffer.byteLength(result.out)).toBeLessThan(9 * 1200);
    const text = await run(["."], { kind: "threads", problems: true }, root, false);
    expect(text.out).toContain("Thread tree — ");
    expect(text.out).toContain("    2026-10-10-grandchild  Grandchild · open");
    expect(text.out).toContain("Problems (");
    expect(text.out).toContain("open-under-closed (1): an open Thread whose current parent");
    expect(text.out).toContain("    2026-10-10-grandchild ← 2026-10-05-closed-track");
    expect(text.out).toContain("    2026-09-30-spine (1), 2026-11-15-fresh (3)");
    expect(text.out).toContain("2026-10-22-far  Far · open · 2026-10-22 [1]");
  });

  it("bounds the tree with --levels and lists at the summary and children rungs", async () => {
    const { root } = space();
    const one = (await run(["."], { kind: "threads", levels: "1" }, root)).json;
    expect(one.members.map((m: { slug: string }) => m.slug)).toEqual(["2026-09-30-spine", "2026-10-15-loose", "2026-10-18-orphan"]);
    expect(one.counts.listed).toBe(3);
    expect(one.counts.threads).toBe(9); // counts are the whole tree; levels bound what is listed
    expect(one.problems).toEqual([]); // not asked for
    const two = (await run(["."], { kind: "threads", levels: "2", depth: "summary" }, root)).json;
    expect(two.members.find((m: { slug: string }) => m.slug === "2026-10-10-grandchild")).toBeUndefined();
    const spine = two.members.find((m: { slug: string }) => m.slug === "2026-09-30-spine");
    expect(spine).toMatchObject({ depth: "summary", summary: "Spine", holder: "Steward", about: [], current_map: { post: null, members: 0 } });
    const children = (await run(["."], { kind: "threads", levels: "1", depth: "children" }, root)).json;
    expect(children.members[0].child_slugs).toEqual(["2026-10-05-closed-track", "2026-10-12-quiet", "2026-10-20-moved", "2026-10-22-far", "2026-11-15-fresh"]);
    const surface = (await run(["."], { kind: "threads", levels: "1", depth: "surface" }, root)).json;
    expect(surface.members[0].newest.map((p: { id: string }) => p.id)).toEqual(["msg_spine_new", "msg_spine_direction", "msg_spine_open"]);
    expect(surface.trimmed).toContain("five newest posts");
  });

  it("filters with --where, flat with each Thread's parent", async () => {
    const { root } = space();
    const closed = (await run(["."], { kind: "threads", where: "closed" }, root)).json;
    expect(closed.members.map((m: { slug: string }) => m.slug)).toEqual(["2026-10-05-closed-track"]);
    const noHolder = (await run(["."], { kind: "threads", where: "no-holder" }, root)).json;
    expect(noHolder.members.map((m: { slug: string }) => m.slug)).toEqual(["2026-10-12-quiet"]);
    const held = (await run(["."], { kind: "threads", where: "holder:scout" }, root)).json;
    expect(held.members.map((m: { slug: string }) => m.slug).sort()).toEqual(["2026-10-05-closed-track", "2026-10-10-grandchild", "2026-10-22-far"]);
    const stale = (await run(["."], { kind: "threads", where: "stale:2026-10-19" }, root)).json;
    // Open Threads with no post since 10-19: not the Spine (a post on 11-14), not the closed track, not those opened after.
    expect(stale.members.map((m: { slug: string }) => m.slug)).toEqual(["2026-10-10-grandchild", "2026-10-12-quiet", "2026-10-15-loose", "2026-10-18-orphan"]);
    expect(stale.where).toBe("stale:2026-10-19");
    const text = await run(["."], { kind: "threads", where: "closed" }, root, false);
    expect(text.out).toContain("2026-10-05-closed-track  Closed track · closed · 1 children · 2026-10-20 ← 2026-09-30-spine");
    expect((await run(["."], { kind: "threads", where: "sideways" }, root)).code).toBe(1);
  });

  it("reads since and as of a moment through the time rule", async () => {
    const { root } = space();
    const sinceRun = await run(["."], { kind: "threads", since: "2026-11-13" }, root);
    expect(sinceRun.code, sinceRun.err).toBe(0);
    const since = sinceRun.json;
    expect(since.members.map((m: { slug: string; new_posts: number }) => [m.slug, m.new_posts])).toEqual([["2026-09-30-spine", 1], ["2026-11-15-fresh", 1]]);
    // An entry id as the cursor: the moment of that entry, found in any root.
    const sinceId = (await run(["."], { kind: "threads", since: "msg_moved_reframe" }, root)).json;
    expect(sinceId.members.map((m: { slug: string }) => m.slug)).toEqual(["2026-09-30-spine", "2026-11-15-fresh"]);
    // As of 2026-10-19 the closed track was open, the moved Thread was not yet named by its reframe, and nothing after exists.
    const asOf = (await run(["."], { kind: "threads", "as-of": "2026-10-19", problems: true }, root)).json;
    const bySlug = Object.fromEntries(asOf.members.map((m: { slug: string }) => [m.slug, m]));
    expect(bySlug["2026-10-05-closed-track"].closed).toBe(false);
    expect(bySlug["2026-10-20-moved"]).toBeUndefined(); // opened on 10-20
    expect(asOf.problems.map((p: { code: string }) => p.code)).not.toContain("open-under-closed");
    expect(asOf.as_of).toBe("2026-10-19");
    const asOfLater = (await run(["."], { kind: "threads", "as-of": "2026-11-13T23:59:59Z" }, root)).json;
    expect(Object.fromEntries(asOfLater.members.map((m: { slug: string; name: string }) => [m.slug, m.name]))["2026-10-20-moved"]).toBe("Moved under 2026-09-30-spine");
    expect((await run(["."], { kind: "threads", since: "msg_nobody" }, root)).code).toBe(1);
    expect((await run(["."], { kind: "threads", "as-of": "yesterday" }, root)).code).toBe(1);
  });

  it("refuses the tree flags without --kind, a kind it does not map, and a numeric depth with threads", async () => {
    const { root } = space();
    for (const flags of [{ levels: "2" }, { problems: true }, { where: "open" }, { since: "2026-11-01" }, { "as-of": "2026-11-01" }]) {
      const result = await run(["."], flags, root);
      expect(result.code).toBe(1);
      expect(result.err).toContain("--kind threads");
    }
    expect((await run(["."], { kind: "repos" }, root)).err).toContain("the one kind is threads");
    expect((await run(["."], { kind: "threads", depth: "2" }, root)).err).toContain("is a rung");
    expect((await run(["."], { kind: "threads", levels: "0" }, root)).code).toBe(1);
    expect((await run(["nowhere"], { kind: "threads" }, root)).code).toBe(1);
    // The content Map keeps its numeric depth untouched.
    expect((await run(["."], { depth: "2" }, root)).code).toBe(0);
  });
});
