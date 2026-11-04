import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";
import { appendPost, createThread, loadThread, readCursor } from "../local/threads.js";
import { readerName, recentSince } from "../local/thread-recent.js";

const temp: string[] = [];
const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  vi.unstubAllEnvs();
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function space() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "is-recent-"))); temp.push(root);
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent/agreement.md"), "---\nname: Agreement — Test\nsummary: Test\n---\n# Test\n");
  process.env.HOME = root;
  return root;
}

async function run(root: string, args: string[], flags: Record<string, string | boolean> = {}) {
  const previous = process.cwd(); process.chdir(root);
  let out = ""; let err = "";
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof stdout;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof stderr;
  try {
    const code = await threadsCommand.run(args, flags, { json: true, quiet: true, yes: false, help: false });
    return { code, json: out ? JSON.parse(out) : undefined, err };
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous);
  }
}

const thread = (root: string, slug: string) => createThread(slug, slug, root);
const post = (path: string, body = "Body") => appendPost(path, { body, author: "Fixture" });

describe("threads recent", () => {
  it("gives a caller a baseline, then only what moved, and writes nothing to do so", async () => {
    const root = space();
    const a = thread(root, "a"); const b = thread(root, "b"); post(a.path); post(b.path);
    const first = (await run(root, ["recent"], { cursor: recentSince(root, join(root, "_threads")).cursor })).json;
    expect(first).toMatchObject({ schema: "ideaspaces.threads.recent.v1", baseline: false, threads: [], moved: 0, location: "folder", hosted_checked: false });
    const before = first.cursor;
    post(a.path); post(a.path);
    const moved = (await run(root, ["recent"], { cursor: before })).json;
    expect(moved.threads).toEqual([{ slug: "a", new_posts: 2 }]);
    expect((await run(root, ["recent"], { cursor: moved.cursor })).json.threads).toEqual([]);
    // The same cursor answers the same again: the caller holds the position.
    expect((await run(root, ["recent"], { cursor: before })).json.threads).toEqual([{ slug: "a", new_posts: 2 }]);
    expect(existsSync(join(root, ".ideaspaces"))).toBe(false);
  });

  it("carries ids and counts, never a name or summary", async () => {
    const root = space();
    const a = thread(root, "a");
    const before = recentSince(root, join(root, "_threads")).cursor;
    post(a.path, "Secret text");
    const json = (await run(root, ["recent"], { cursor: before })).json;
    expect(Object.keys(json.threads[0]).sort()).toEqual(["new_posts", "slug"]);
    expect(JSON.stringify(json)).not.toContain("Secret");
  });

  it("finds a post dated before the last look: a merge must not lose it", async () => {
    const root = space();
    const a = thread(root, "a"); post(a.path);
    const before = recentSince(root, join(root, "_threads")).cursor;
    writeFileSync(join(a.path, "2001-01-01T00-00-00-000Z-merged.md"), "---\nid: msg_merged\nkind: post\ndate: 2001-01-01T00:00:00.000Z\n---\nMerged\n");
    expect((await run(root, ["recent"], { cursor: before })).json.threads).toEqual([{ slug: "a", new_posts: 1 }]);
  });

  it("says a Thread changed when posts left, and names a new Thread", async () => {
    const root = space();
    const a = thread(root, "a"); const { path } = post(a.path);
    const before = recentSince(root, join(root, "_threads")).cursor;
    rmSync(path);
    thread(root, "b");
    const rows = (await run(root, ["recent"], { cursor: before })).json.threads;
    expect(rows).toEqual(expect.arrayContaining([{ slug: "a", new_posts: 0, changed: true }, expect.objectContaining({ slug: "b", new_thread: true })]));
  });

  it("refuses a cursor from another Space or that it did not write", async () => {
    const one = space(); const cursor = recentSince(one, join(one, "_threads")).cursor;
    const other = space();
    expect((await run(other, ["recent"], { cursor })).code).toBe(1);
    expect((await run(other, ["recent"], { cursor: "not-a-cursor" })).code).toBe(1);
    expect((await run(other, ["recent"], { cursor, reader: "scout" })).code).toBe(1);
  });

  it("stays small enough for an agent to hold", () => {
    const root = space();
    for (let i = 0; i < 74; i++) mkdirSync(join(root, "_threads", `thread-${i}`), { recursive: true });
    expect(recentSince(root, join(root, "_threads")).cursor.length).toBeLessThan(1300);
  });
});

describe("a named reader", () => {
  it("baselines once, keeps its position until it moves it, and is untouched by another reader", async () => {
    const root = space();
    const a = thread(root, "a"); post(a.path);
    expect((await run(root, ["recent"], { reader: "scout" })).json).toMatchObject({ baseline: true, reader: "scout", threads: [] });
    await run(root, ["recent"], { reader: "desktop" });
    post(a.path);
    const scout = (await run(root, ["recent"], { reader: "scout" })).json;
    expect(scout).toMatchObject({ baseline: false, threads: [{ slug: "a", new_posts: 1 }] });
    // A look moves nothing, so a session that dies part way loses nothing.
    expect((await run(root, ["recent"], { reader: "scout" })).json.threads).toHaveLength(1);
    expect((await run(root, ["ack"], { recent: scout.cursor, reader: "desktop" })).code).toBe(0);
    expect((await run(root, ["recent"], { reader: "desktop" })).json.threads).toEqual([]);
    expect((await run(root, ["recent"], { reader: "scout" })).json.threads).toHaveLength(1);
    expect((await run(root, ["ack"], { recent: scout.cursor, reader: "scout" })).code).toBe(0);
    expect((await run(root, ["recent"], { reader: "scout" })).json.threads).toEqual([]);
  });

  it("is what the host names, defaults to the person, and refuses a name that is not a name", async () => {
    expect(readerName(undefined, undefined)).toBe("person");
    expect(readerName(undefined, " ")).toBe("person");
    expect(readerName(undefined, "scout")).toBe("scout");
    expect(readerName("explicit", "scout")).toBe("explicit");
    for (const bad of ["../up", "a/b", "", ".hidden", "x".repeat(65)]) expect(() => readerName(bad)).toThrow(/Invalid reader/);
    const root = space();
    vi.stubEnv("IDEASPACES_READER", "from-host");
    expect((await run(root, ["recent"])).json.reader).toBe("from-host");
  });
});

describe("threads ack on a local Thread", () => {
  it("says how far, moves one reader only, and never reaches past what it names", async () => {
    const root = space();
    const a = thread(root, "a");
    const one = post(a.path); const two = post(a.path);
    expect((await run(root, ["ack", "a"])).err).toContain("how far you read");
    expect((await run(root, ["ack", "a"], { through: "msg_none" })).err).toContain("not in this Thread");
    expect((await run(root, ["ack", "a"], { through: one.post.id, reader: "scout" })).json).toMatchObject({ reader: "scout", position: one.post.id });
    const loaded = loadThread(a.path);
    expect(readCursor(loaded, "scout").has(one.post.id)).toBe(true);
    expect(readCursor(loaded, "scout").has(two.post.id)).toBe(false);
    expect(readCursor(loaded).size).toBe(0); // the person's position did not move
    expect((await run(root, ["list"], { new: true, reader: "scout" })).json.threads).toHaveLength(1);
    expect((await run(root, ["ack", "a"], { through: "latest", reader: "scout" })).code).toBe(0);
    expect((await run(root, ["list"], { new: true, reader: "scout" })).json.threads).toHaveLength(0);
    expect((await run(root, ["list"], { new: true })).json.threads).toHaveLength(1);
  });
});

describe("threads list and name reads", () => {
  it("lists by activity, newest first, and hides closed only when asked", async () => {
    const root = space();
    const older = thread(root, "a-older"); const newer = thread(root, "z-newer");
    post(older.path); post(newer.path);
    writeFileSync(join(newer.path, "2030-01-01T00-00-00-000Z-later.md"), "---\nid: msg_later\nkind: post\ndate: 2030-01-01T00:00:00.000Z\n---\nLater\n");
    const slugs = (flags = {}) => run(root, ["list"], flags).then(({ json }) => json.threads.map((row: { slug: string }) => row.slug));
    expect(await slugs()).toEqual(["z-newer", "a-older"]); // alphabetical order would be the reverse
    expect((await run(root, ["close", "z-newer"], { message: "Done", author: "Fixture" })).code).toBe(0);
    expect(await slugs()).toEqual(["z-newer", "a-older"]);
    expect(await slugs({ open: true })).toEqual(["a-older"]);
  });

  it("keeps the Agreement line in a name read and leaves the skills out", async () => {
    const root = space();
    mkdirSync(join(root, "_agent/skills"));
    writeFileSync(join(root, "_agent/skills/a-skill.md"), "---\nname: a-skill\ndescription: A skill\n---\nBody\n");
    thread(root, "a");
    const { json } = await run(root, ["open", "a"], { depth: "name" });
    expect(json.reference.skills).toEqual([]);
    expect(JSON.stringify(json.reference.contract)).toContain("agreement");
    expect((await run(root, ["open", "a"], { depth: "summary" })).json.reference.skills).toHaveLength(1);
  });
});
