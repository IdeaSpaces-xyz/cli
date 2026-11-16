import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, createThread, loadThread } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

// Protocol 0.33.0, time.md: a Thread's name, parent and closed state come from its entries by one
// rule (the newest readable entry that carries the field), never from a kind check or the README.
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function space(): string {
  const root = mkdtempSync(join(tmpdir(), "is-state-rule-")); temp.push(root);
  process.env.HOME = root;
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Fixture Space\nsummary: Space terms.\n---\n# Space\n");
  return root;
}

async function run(args: string[], options: Record<string, string | boolean>, cwd: string, quiet = true) {
  const previous = process.cwd(); process.chdir(cwd);
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  let out = ""; let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run(args, options, { json: true, quiet, yes: false, help: false });
    return { code, out, err, json: out.trim() ? JSON.parse(out) : undefined };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous); }
}

describe("a Thread's state comes from its entries", () => {
  it("names the Thread by the newest reframe, else the opening post; the README only speaks when no post names it", () => {
    const root = space();
    const t = createThread("naming", "The opening title", root);
    // A README that disagrees with the entries is a stale view, not the name.
    writeFileSync(join(t.path, "README.md"), "---\nname: A curated title\nsummary: The curated line\n---\n\n# Curated\n");
    expect(loadThread(t.path)).toMatchObject({ name: "A curated title", nameSource: "readme", summary: "The curated line", summarySource: "readme" });
    appendPost(t.path, { body: "Opening", name: "The opening title", summary: "The opening title" });
    expect(loadThread(t.path)).toMatchObject({ name: "The opening title", nameSource: "opening", summary: "The curated line", summarySource: "readme" });
    // A reframe that carries name and summary renames; one that only moves (no name) leaves them alone.
    appendPost(t.path, { body: "Renamed because the scope grew.", kind: "reframe", name: "A wider title", summary: "The wider line", replyTo: ["latest"] });
    expect(loadThread(t.path)).toMatchObject({ name: "A wider title", nameSource: "reframe", summary: "The wider line", summarySource: "reframe" });
  });

  it("writes parent beside attached_to on an opening post, and about for a link that is not a post", async () => {
    const root = space();
    const parent = await run(["new", "parent"], { about: "Parent" }, root);
    expect(parent.code).toBe(0);
    const opening = parent.json.opening_post_id as string;
    const child = await run(["new", "child"], { about: "Child", "attached-to": `post:${opening}` }, root);
    expect(child.code, child.err).toBe(0);
    expect(child.json).toMatchObject({ attached_to: `post:${opening}`, parent: `post:${opening}` });
    const childOpening = readFileSync(join(root, "_threads", "child", loadThread(join(root, "_threads", "child")).allPosts[0].path), "utf8");
    expect(childOpening).toContain(`parent: post:${opening}`);
    expect(childOpening).toContain(`attached_to: post:${opening}`);
    const loadedChild = loadThread(join(root, "_threads", "child"));
    expect(loadedChild.attachment).toMatchObject({ kind: "post", value: opening });
    expect(loadedChild.parentSource).toBe("origin");
    expect(loadedChild.about).toEqual([]);

    const linked = await run(["new", "linked"], { about: "Linked", "attached-to": "note:@home//notes/topic.md" }, root);
    expect(linked.code, linked.err).toBe(0);
    expect(linked.json).toMatchObject({ attached_to: "note:@home//notes/topic.md", about: ["note:@home//notes/topic.md"] });
    const loadedLinked = loadThread(join(root, "_threads", "linked"));
    expect(loadedLinked.about).toMatchObject([{ kind: "note", value: "@home//notes/topic.md" }]);
    expect(loadedLinked.attachment).toBeNull();
    const rows = (await run(["list"], { depth: "name" }, root)).json.threads as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.slug === "linked")).toMatchObject({ about: ["note:@home//notes/topic.md"], parent_source: null, name_source: "opening" });
    expect(rows.find((row) => row.slug === "child")).toMatchObject({ about: [], parent_source: "origin" });
  });

  it("writes closed: true beside the legacy closure kind, refuses a parent that is not a post, and takes --kind snapshot as a post with a Map", async () => {
    const root = space();
    const t = createThread("closing", "Closing", root);
    const opening = appendPost(t.path, { body: "Opening" });
    expect(() => appendPost(t.path, { body: "Move", kind: "reframe", parent: "note:@home//x.md", replyTo: [opening.post.id] })).toThrow(/--parent must name a post/);
    expect(() => appendPost(t.path, { body: "About", about: ["no-type"], replyTo: [opening.post.id] })).toThrow(/--about links are <type>:<id>/);
    const snap = await run(["post", "closing"], { kind: "snapshot", message: "Where it stands", map: "empty.map.md", author: "Tester", "no-commit": true }, root);
    expect(snap.code).toBe(1); // the Map note does not exist; nothing written
    writeFileSync(join(root, "empty.map.md"), "---\nmap:\n  roots: []\n  members: []\n---\nCleared frame\n");
    const written = await run(["post", "closing"], { kind: "snapshot", message: "Where it stands", map: "empty.map.md", author: "Tester", "no-commit": true }, root, false);
    expect(written.code, written.err).toBe(0);
    expect(written.json.kind).toBe("post");
    expect(written.err).toContain("snapshot is a legacy kind");
    expect(loadThread(t.path).currentMap.post?.id).toBe(written.json.id);
    const closed = await run(["close", "closing"], { message: "Done.", author: "Tester", "no-commit": true }, root);
    expect(closed.code, closed.err).toBe(0);
    expect(closed.json.kind).toBe("closure");
    const file = readFileSync(closed.json.path as string, "utf8");
    expect(file).toMatch(/^kind: closure$/m);
    expect(file).toMatch(/^closed: true$/m);
    expect(loadThread(t.path).closed).toBe(true);
  });
});
