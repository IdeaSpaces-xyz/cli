import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, createThread } from "../local/threads.js";
import { checkPostLinks } from "../local/post-links.js";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function space() {
  const dir = mkdtempSync(join(tmpdir(), "is-post-links-")); temp.push(dir);
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  mkdirSync(join(dir, "knowledge"));
  writeFileSync(join(dir, "knowledge", "note.md"), "# Note\n");
  return dir;
}

describe("post link check", () => {
  it("resolves links from the post file and accepts real targets, web links and anchors", () => {
    const root = space();
    const t = createThread("t", "T", root);
    const r = checkPostLinks(
      "[a](../../knowledge/note.md) [b](../../knowledge/note.md#top) [c](https://example.com/x.md) [d](#here) [e](mailto:a@b.c) [f](nope.md)",
      t.path, root);
    expect(r.errors).toEqual([`nope.md: no file at ${join(t.path, "nope.md")}. Links are relative to the post file, which sits in ${t.path}.`]);
    expect(r.warnings).toEqual([]);
  });

  it("refuses a bad path before any file is written, naming the link and where it resolves from", () => {
    const root = space();
    const t = createThread("t", "T", root);
    const before = readdirSync(t.path).length;
    expect(() => appendPost(t.path, { body: "See [note](knowledge/note.md)", checkLinks: true }))
      .toThrow(/Post not written.*knowledge\/note\.md: no file at .*relative to the post file/s);
    expect(readdirSync(t.path).length).toBe(before);
    const ok = appendPost(t.path, { body: "See [note](../../knowledge/note.md)", checkLinks: true });
    expect(ok.warnings).toEqual([]);
  });

  it("refuses absolute paths and paths that leave the Space", () => {
    const root = space();
    const t = createThread("t", "T", root);
    const r = checkPostLinks("[a](/etc/passwd) [b](../../../outside.md)", t.path, root);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/absolute/);
    expect(r.errors[1]).toMatch(/outside the Space/);
  });

  it("allows a forward reference to a post not yet written, with a warning", () => {
    const root = space();
    const t = createThread("t", "T", root);
    const post = "2026-11-03T09-00-00-000Z-msg_0a1b2c3d-0000-4000-8000-000000000000.md";
    const out = appendPost(t.path, { body: `Answered in [the reply](${post}).`, checkLinks: true });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/forward reference/);
  });

  it("ignores links inside code and keeps Map positions out of it", () => {
    const root = space();
    const t = createThread("t", "T", root);
    const r = checkPostLinks("Write `[x](nope.md)` like this:\n\n```md\n[y](also-nope.md)\n```\n", t.path, root);
    expect(r).toEqual({ errors: [], warnings: [] });
    // A Map position is repository-relative; it is never resolved from the post file, so only the body is checked.
    const map = { roots: [{ root_node_id: "n_x", sha: "a".repeat(40) }], members: [{ root: 0, position: "knowledge/note.md", depth: "summary" }] };
    expect(() => appendPost(t.path, { body: "Cites the note by Map.", map, checkLinks: true })).not.toThrow(/Post not written/);
  });

  it("does not check bodies unless asked", () => {
    const root = space();
    const t = createThread("t", "T", root);
    expect(() => appendPost(t.path, { body: "[x](missing.md)" })).not.toThrow();
  });
});
