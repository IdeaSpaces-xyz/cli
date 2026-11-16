import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lookCommand } from "../commands/look.js";
import { appendPost, createThread } from "../local/threads.js";
import type { GlobalFlags } from "../types.js";

// Protocol 0.33.0: a folder that keeps time has a state its entries set, and reads in time. AX's
// four memory checks (add, supersede, as of, since), each one call, on a memory-shaped folder that
// keeps time by its Agreement, and the same on a Thread.
vi.mock("../auth/credentials.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/credentials.js")>()), loadConfig: vi.fn(() => null) }));

const JSON_FLAGS: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
let root: string;
let cwd: string;
const originalHome = process.env.HOME;

function git(...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
async function look(args: string[], flags: Record<string, string | boolean> = {}, global: GlobalFlags = JSON_FLAGS) {
  const out: string[] = []; const err: string[] = [];
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  let exit: number;
  try { exit = await lookCommand.run(args, flags, global); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  const text = out.join("");
  return { exit, data: global.json && text ? JSON.parse(text) : null, text, err: err.join("") };
}
/** The page's filenames: a child's `name` is its title when it has one; its position ends with the file. */
const files = (data: { target: { children: Array<{ position: string }> } }) => data.target.children.map((child) => basename(child.position));
const child = (data: { target: { children: Array<{ position: string; post?: unknown }> } }, file: string) => data.target.children.find((entry) => basename(entry.position) === file);
function entry(dir: string, file: string, id: string, extra = "", body = "Body.") {
  writeFileSync(join(dir, file), `---\nid: ${id}\ndate: ${file.slice(0, 10)}T10:00:00.000Z\n${/^kind:/m.test(extra) ? "" : "kind: post\n"}${extra}---\n\n${body}\n`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "is-look-state-")));
  cwd = process.cwd(); process.chdir(root); process.env.HOME = root;
  git("init", "-q", "-b", "main"); git("config", "user.email", "look@example.test"); git("config", "user.name", "Look Test");
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Space\nsummary: Space terms.\n---\n# Space\n");
});
afterEach(() => { process.chdir(cwd); process.env.HOME = originalHome; rmSync(root, { recursive: true, force: true }); });

describe("look on a folder that keeps time", () => {
  it("starts a Thread with its state, read as of a moment, and pages since an entry id or a date", async () => {
    const t = createThread("decision", "A decision", root);
    entry(t.path, "2026-10-01-opening.md", "msg_open", "author: Scout\nname: A decision\nsummary: Why it matters.\nparent: post:msg_elsewhere\nattached_to: post:msg_elsewhere\n");
    entry(t.path, "2026-10-05-reply.md", "msg_reply", "in_reply_to: msg_open\nauthor: Backend\nname: First reply\n");
    entry(t.path, "2026-10-10-moved.md", "msg_moved", "kind: reframe\nin_reply_to: msg_reply\nparent: post:msg_newhome\n", "Moved; name and summary unchanged.\n");
    entry(t.path, "2026-10-20-closed.md", "msg_closed", "kind: closure\nclosed: true\nin_reply_to: msg_moved\nauthor: Scout\n", "Done.");
    git("add", "-A"); git("commit", "-q", "-m", "thread");

    const now = await look(["_threads/decision"]);
    expect(now.exit, now.err).toBe(0);
    expect(now.data.state).toMatchObject({
      keeping: "placement", position: "_threads/decision", name: "A decision", name_source: "opening", summary: "A decision",
      parent: { value: "post:msg_newhome", source: "post", origin: "post:msg_elsewhere" }, about: [], closed: true,
      current_map: { status: "none", post: null, members: 0, reason: "no_map" }, entries: 4, notes: 0, unreadable: [], superseded: [],
    });
    expect(now.data.state.as_of).toBeUndefined();
    const text = await look(["_threads/decision"], {}, { ...JSON_FLAGS, json: false });
    expect(text.text).toContain("State of _threads/decision (a Thread):");
    expect(text.text).toContain("  name: A decision (from the opening post)");
    expect(text.text).toContain("  parent: post:msg_newhome (from a post) · origin: post:msg_elsewhere");
    expect(text.text).toContain("  closed: true");
    expect(text.text.indexOf("State of")).toBeLessThan(text.text.indexOf("decision"));

    // As of 2026-10-09, end of day: not yet moved, not yet closed, two entries; the later two left out of the page too.
    const then = await look(["_threads/decision"], { "as-of": "2026-10-09", depth: "children" });
    expect(then.exit, then.err).toBe(0);
    expect(then.data.state).toMatchObject({ parent: { value: "post:msg_elsewhere", source: "origin" }, closed: false, entries: 2, as_of: { cursor: "2026-10-09", excluded: 2 } });
    expect(then.data.as_of).toBe("2026-10-09");
    expect(files(then.data)).toEqual(["2026-10-01-opening.md", "2026-10-05-reply.md"]);
    expect(then.data.target.page).toMatchObject({ shown: 2, total: 2 });
    // As of an entry id: that entry and everything before it.
    const atReply = await look(["_threads/decision"], { "as-of": "msg_reply" });
    expect(atReply.data.state).toMatchObject({ closed: false, entries: 2 });
    // Since an entry id, and since a date, page from the protocol's filename cursor.
    const sinceId = await look(["_threads/decision"], { since: "msg_reply" });
    expect(sinceId.exit, sinceId.err).toBe(0);
    expect(files(sinceId.data)).toEqual(["2026-10-10-moved.md", "2026-10-20-closed.md"]);
    const sinceDate = await look(["_threads/decision"], { since: "2026-10-10" });
    expect(files(sinceDate.data)).toEqual(["2026-10-20-closed.md"]);
    const sinceFile = await look(["_threads/decision"], { since: "2026-10-05-reply.md" });
    expect(files(sinceFile.data)).toEqual(["2026-10-10-moved.md", "2026-10-20-closed.md"]);
    // Refusals say what to do instead.
    expect((await look(["_threads/decision"], { since: "msg_nobody" })).err).toContain("names no entry");
    expect((await look(["_threads/decision"], { "as-of": "2026-10-09", post: "msg_open" })).err).toContain("does not combine");
    expect((await look(["_threads/decision"], { "as-of": "2030-01-01" })).data.state.entries).toBe(4);
    expect((await look(["_threads/decision"], { "as-of": "2020-01-01" })).data.state).toMatchObject({ entries: 0, as_of: { excluded: 4 } });
  }, 60_000); // Several looks with Git startup exceed 5 s on Windows.

  it("passes AX's four memory checks on a folder that keeps time by its Agreement: add, supersede, as of, since", async () => {
    const memory = join(root, "memory");
    mkdirSync(join(memory, "_agent"), { recursive: true });
    writeFileSync(join(memory, "_agent", "agreement.md"), "---\nname: Agreement — Memory\nsummary: What shipping taught.\nkeeps_time: true\n---\n# Memory\n");
    // Two ordinary Notes, as memory folders have today: no id, outside the timeline, still listed.
    writeFileSync(join(memory, "MEMORY.md"), "---\nname: Index\nsummary: The index.\n---\n# Index\n");
    writeFileSync(join(memory, "2026-10-01-an-old-lesson.md"), "---\nname: An old lesson\nsummary: Edited in place for weeks.\n---\n# Old\n");
    git("add", "-A"); git("commit", "-q", "-m", "memory");

    // 1. Add: a lesson is an entry.
    entry(memory, "2026-11-01-first-lesson.md", "mem_first", "author: Integrator\nname: Pin the protocol by commit\nsummary: A squash merge makes a new SHA.\n");
    const added = await look(["memory"], { depth: "children" });
    expect(added.exit, added.err).toBe(0);
    expect(added.data.state).toMatchObject({ keeping: "agreement", position: "memory", entries: 1, notes: 2, superseded: [], closed: false, parent: null, name: null });
    expect(child(added.data, "2026-11-01-first-lesson.md")?.post).toMatchObject({ id: "mem_first", kind: "post", author: "Integrator" });
    expect(child(added.data, "2026-10-01-an-old-lesson.md")?.post).toBeUndefined();

    // 2. Supersede: a correction that supersedes; the old entry stays and is named superseded.
    entry(memory, "2026-11-10-corrected.md", "mem_second", "kind: correction\nsupersedes: mem_first\nauthor: Integrator\nname: Pin the protocol by tag\nsummary: A tag resolves to the merge commit in the lock.\n");
    const superseded = await look(["memory"]);
    expect(superseded.data.state).toMatchObject({ entries: 2, superseded: ["mem_first"] });
    const text = await look(["memory"], {}, { ...JSON_FLAGS, json: false });
    expect(text.text).toContain("State of memory (a folder that keeps time (keeps_time: true)):");
    expect(text.text).toContain("entries: 2 · notes: 2 · superseded: mem_first");

    // 3. As of: before the correction, nothing was superseded; the correction is left out of the page.
    const asOf = await look(["memory"], { "as-of": "2026-11-05", depth: "children" });
    expect(asOf.exit, asOf.err).toBe(0);
    expect(asOf.data.state).toMatchObject({ entries: 1, superseded: [], as_of: { cursor: "2026-11-05", excluded: 1 } });
    expect(files(asOf.data)).toEqual(["2026-10-01-an-old-lesson.md", "2026-11-01-first-lesson.md", "MEMORY.md"]);

    // 4. Since: what is new after the first lesson, by id and by date.
    const since = await look(["memory"], { since: "mem_first" });
    expect(since.exit, since.err).toBe(0);
    expect(files(since.data)).toEqual(["2026-11-10-corrected.md", "MEMORY.md"]);
    const sinceDate = await look(["memory"], { since: "2026-11-02" });
    expect(files(sinceDate.data)).toEqual(["2026-11-10-corrected.md", "MEMORY.md"]);
  }, 60_000);

  it("gives no state to a folder that keeps no time, and refuses --as-of there", async () => {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "---\nname: A\nsummary: A note.\n---\n# A\n");
    git("add", "-A"); git("commit", "-q", "-m", "docs");
    const plain = await look(["docs"], { depth: "children" });
    expect(plain.exit, plain.err).toBe(0);
    expect(plain.data.state).toBeUndefined();
    const refused = await look(["docs"], { "as-of": "2026-11-01" });
    expect(refused.exit).toBe(1);
    expect(refused.err).toContain("keeps time");
    expect(refused.err).toContain("--pin");
    // Outside a folder that keeps time, --since stays the protocol's page cursor and its refusal.
    const badSince = await look(["docs"], { since: "msg_x" });
    expect(badSince.exit).toBe(1);
    expect(badSince.err).toContain("Re-read the first page");
    // A Thread post itself has no folder state; --as-of on a file is refused the same way.
    const t = createThread("one", "One", root);
    const opening = appendPost(t.path, { body: "Opening" });
    expect((await look([join("_threads", "one", opening.post.path)], { "as-of": "2026-11-01" })).exit).toBe(1);
  }, 60_000);
});
