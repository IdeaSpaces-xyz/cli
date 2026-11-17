import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { postCommand } from "../commands/post.js";
import { lookCommand } from "../commands/look.js";
import { threadsCommand } from "../commands/threads.js";
import { appendPost, createThread, loadThread } from "../local/threads.js";
import { folderState } from "../local/folder-state.js";
import type { GlobalFlags } from "../types.js";

// The one writer over anything that keeps time (protocol 0.33.0): a Thread, a folder whose
// Agreement says keeps_time: true, and the opening of a Thread. Hosted posting is the service's
// writer and is covered by the hosted Thread tests.
vi.mock("../auth/credentials.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../auth/credentials.js")>()), loadConfig: vi.fn(() => null), peekConfig: () => null }));

const JSON_FLAGS: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
let root: string;
let cwd: string;
const originalHome = process.env.HOME;

function git(...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
async function run(command: { run: (a: string[], f: Record<string, string | boolean>, g: GlobalFlags) => Promise<number> }, args: string[], flags: Record<string, string | boolean> = {}, global: GlobalFlags = JSON_FLAGS) {
  const out: string[] = []; const err: string[] = [];
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  let exit: number;
  try { exit = await command.run(args, flags, global); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  const text = out.join("");
  return { exit, data: global.json && text ? JSON.parse(text) : null, text, err: err.join("") };
}
const post = (args: string[], flags: Record<string, string | boolean> = {}, global?: GlobalFlags) => run(postCommand, args, { author: "Tester", ...flags }, global);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "is-post-")));
  cwd = process.cwd(); process.chdir(root); process.env.HOME = root;
  git("init", "-q", "-b", "main"); git("config", "user.email", "post@example.test"); git("config", "user.name", "Post Test");
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Space\nsummary: Space terms.\n---\n# Space\n");
  git("add", "-A"); git("commit", "-q", "-m", "space");
});
afterEach(() => { process.chdir(cwd); process.env.HOME = originalHome; rmSync(root, { recursive: true, force: true }); });

describe("ideaspaces post", () => {
  it("appends to a Thread, moves it with a reframe that keeps the name, renames with one that carries a name, and closes it", async () => {
    const spine = createThread("spine", "Spine", root);
    const spineOpen = appendPost(spine.path, { body: "Trunk", name: "Spine", author: "Steward" });
    const other = appendPost(spine.path, { body: "Direction", name: "Direction", author: "Steward", replyTo: [spineOpen.post.id] });
    const t = createThread("topic", "A topic", root);
    const opening = appendPost(t.path, { body: "Opening", name: "A topic", summary: "A topic", author: "Scout", parent: `post:${spineOpen.post.id}`, attachedTo: `post:${spineOpen.post.id}` });
    git("add", "-A"); git("commit", "-q", "-m", "threads");

    const plain = await post(["topic"], { message: "A plain post.", "reply-to": opening.post.id });
    expect(plain.exit, plain.err).toBe(0);
    expect(plain.data).toMatchObject({ kind: "post", in_reply_to: [opening.post.id], folder: { position: "_threads/topic", keeping: "placement" }, committed: true });
    expect(git("show", "--name-only", "--format=%s", "HEAD").split("\n")[0]).toBe(`Thread topic: post ${plain.data.id}`);
    expect(git("status", "--porcelain")).toBe("");

    // A move: the reframe carries parent and no name; the Thread's name stays, its parent moves.
    const moved = await post(["topic"], { kind: "reframe", parent: `post:${other.post.id}`, message: "It belongs under the direction now." });
    expect(moved.exit, moved.err).toBe(0);
    expect(moved.data).toMatchObject({ kind: "reframe", parent: `post:${other.post.id}`, committed: true });
    const file = readFileSync(moved.data.path, "utf8");
    expect(file).toContain(`parent: post:${other.post.id}`);
    expect(file).not.toMatch(/^name:/m);
    let loaded = loadThread(t.path);
    expect(loaded.name).toBe("A topic");
    expect(loaded.attachment).toMatchObject({ kind: "post", value: other.post.id });
    expect(loaded.parentSource).toBe("post");
    // threads list shows the move as the state rule reads it.
    const rows = (await run(threadsCommand, ["list"], { depth: "name" })).data.threads;
    expect(rows.find((row: { slug: string }) => row.slug === "topic")).toMatchObject({ name: "A topic", parent: { id: other.post.id, slug: "spine" }, parent_source: "post" });

    // A rename: the reframe carries the Thread's own name and summary.
    const renamed = await post(["topic"], { kind: "reframe", name: "A wider topic", summary: "Now with scope.", message: "The scope grew." });
    expect(renamed.exit, renamed.err).toBe(0);
    loaded = loadThread(t.path);
    expect(loaded).toMatchObject({ name: "A wider topic", nameSource: "reframe", summary: "Now with scope.", summarySource: "reframe" });

    // About: typed links, then cleared.
    const about = await post(["topic"], { about: "note:@home//notes/why.md,change:chg_1", message: "What it is about." });
    expect(about.exit, about.err).toBe(0);
    expect(loadThread(t.path).about.map((a) => a.raw)).toEqual(["note:@home//notes/why.md", "change:chg_1"]);
    const cleared = await post(["topic"], { about: "", message: "Nothing to link now." });
    expect(cleared.exit, cleared.err).toBe(0);
    expect(readFileSync(cleared.data.path, "utf8")).toMatch(/^about: \[\]$/m);
    expect(loadThread(t.path).about).toEqual([]);

    // A close writes the field beside the legacy kind; the Thread refuses the next write; reopen with --closed false is a reframe-less post.
    const closed = await post(["topic"], { closed: "true", message: "Done." });
    expect(closed.exit, closed.err).toBe(0);
    const closedFile = readFileSync(closed.data.path, "utf8");
    expect(closedFile).toMatch(/^kind: closure$/m);
    expect(closedFile).toMatch(/^closed: true$/m);
    expect(loadThread(t.path).closed).toBe(true);
    expect((await post(["topic"], { message: "Too late." })).err).toContain("closed");
    // Reopening is the one write a closed Thread takes.
    const reopened = await post(["topic"], { closed: "false", message: "Not done after all." });
    expect(reopened.exit, reopened.err).toBe(0);
    expect(readFileSync(reopened.data.path, "utf8")).toMatch(/^closed: false$/m);
    expect(loadThread(t.path).closed).toBe(false);
    const closedAgain = await post(["topic"], { closed: "true", message: "Done, this time." });
    expect(closedAgain.exit, closedAgain.err).toBe(0);
    // The state look reads the same.
    const state = (await run(lookCommand, ["_threads/topic"])).data.state;
    expect(state).toMatchObject({ name: "A wider topic", closed: true, parent: { value: `post:${other.post.id}`, source: "post" } });

    // The post verb and threads post write the same file shape: same commit subject form, same fields.
    expect(git("log", "--format=%s", "-8").split("\n")).toEqual([
      `Thread topic: closure ${closedAgain.data.id}`, `Thread topic: post ${reopened.data.id}`,
      `Thread topic: closure ${closed.data.id}`, `Thread topic: post ${cleared.data.id}`, `Thread topic: post ${about.data.id}`,
      `Thread topic: reframe ${renamed.data.id}`, `Thread topic: reframe ${moved.data.id}`, `Thread topic: post ${plain.data.id}`,
    ]);
  }, 60_000);

  it("writes entries into a folder that keeps time by its Agreement: add, correct, close and reopen, with Notes left alone", async () => {
    const memory = join(root, "memory");
    mkdirSync(join(memory, "_agent"), { recursive: true });
    writeFileSync(join(memory, "_agent", "agreement.md"), "---\nname: Agreement — Memory\nsummary: Lessons.\nkeeps_time: true\n---\n# Memory\n");
    writeFileSync(join(memory, "MEMORY.md"), "---\nname: Index\n---\n# Index\n");
    git("add", "-A"); git("commit", "-q", "-m", "memory");

    const first = await post(["memory"], { message: "A squash merge makes a new SHA.", name: "Pin the protocol by commit", summary: "Repin after the merge." });
    expect(first.exit, first.err).toBe(0);
    expect(first.data).toMatchObject({ kind: "post", in_reply_to: [], folder: { position: "memory", keeping: "agreement" }, committed: true });
    expect(basename(first.data.path)).toMatch(/^\d{4}-\d{2}-\d{2}T.*-msg_[0-9a-f-]+\.md$/);
    expect(git("show", "--name-only", "--format=%s", "HEAD").split("\n")[0]).toBe(`memory: post ${first.data.id}`);
    const entryFile = readFileSync(first.data.path, "utf8");
    expect(entryFile).toMatch(/^id: msg_/m);
    expect(entryFile).not.toMatch(/^in_reply_to:/m); // a lesson answers nothing by default

    const second = await post(["memory"], { kind: "correction", supersedes: first.data.id, name: "Pin the protocol by tag", message: "The tag resolves in the lock." });
    expect(second.exit, second.err).toBe(0);
    let state = folderState(memory)!;
    expect(state).toMatchObject({ keeping: "agreement", entries: 2, notes: 1, superseded: [first.data.id], closed: false });

    const reply = await post(["memory"], { "reply-to": second.data.id.slice(0, 12), message: "Seen it bite twice." });
    expect(reply.exit, reply.err).toBe(0);
    expect(reply.data.in_reply_to).toEqual([second.data.id]);

    const closed = await post(["memory"], { closed: "true", message: "This folder moves to lessons/." });
    expect(closed.exit, closed.err).toBe(0);
    expect(folderState(memory)!.closed).toBe(true);
    const refused = await post(["memory"], { message: "One more." });
    expect(refused.exit).toBe(1);
    expect(refused.err).toContain("is closed");
    expect(refused.err).toContain("--closed false");
    const reopened = await post(["memory"], { closed: "false", message: "Back here after all." });
    expect(reopened.exit, reopened.err).toBe(0);
    state = folderState(memory)!;
    expect(state.closed).toBe(false);
    expect(state.entries).toBe(5);
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toContain("# Index"); // Notes untouched

    // Refusals say what to do instead.
    expect((await post(["memory"], { kind: "correction", message: "No target." })).err).toContain("--supersedes");
    expect((await post(["memory"], { kind: "reframe", parent: "note:@x//y.md", message: "Not a post." })).err).toContain("--parent must name a post");
    expect((await post(["memory"], { kind: "sideways", message: "x" })).err).toContain("is not a kind");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "# A\n");
    const plain = await post(["docs"], { message: "Nowhere to go." });
    expect(plain.exit).toBe(1);
    expect(plain.err).toContain("keeps no time");
    expect(plain.err).toContain("keeps_time: true");
  }, 60_000);

  it("opens a Thread with --new: the opening carries parent or about beside attached_to, and the three files are committed together", async () => {
    const spine = createThread("spine", "Spine", root);
    const spineOpen = appendPost(spine.path, { body: "Trunk", name: "Spine", author: "Steward" });
    git("add", "-A"); git("commit", "-q", "-m", "spine");
    const opened = await post([], { new: "2026-11-17-a-topic", name: "A topic", summary: "What it is for.", parent: `post:${spineOpen.post.id}`, about: "note:@home//notes/why.md", message: "Where this starts." });
    expect(opened.exit, opened.err).toBe(0);
    expect(opened.data).toMatchObject({ slug: "2026-11-17-a-topic", name: "A topic", summary: "What it is for.", parent: `post:${spineOpen.post.id}`, about: ["note:@home//notes/why.md"], attached_to: `post:${spineOpen.post.id}`, committed: true });
    const dir = join(root, "_threads", "2026-11-17-a-topic");
    const opening = readFileSync(join(dir, basename(loadThread(dir).allPosts[0].path)), "utf8");
    expect(opening).toContain(`parent: post:${spineOpen.post.id}`);
    expect(opening).toContain(`attached_to: post:${spineOpen.post.id}`);
    expect(opening).toContain("about:\n  - note:@home//notes/why.md");
    expect(opening).toContain("Where this starts.");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("summary: What it is for.");
    expect(git("status", "--porcelain")).toBe("");
    const shown = git("show", "--name-only", "--format=%s%n%b", "HEAD").split("\n").filter(Boolean);
    expect(shown[0]).toBe("Thread 2026-11-17-a-topic: opened");
    expect(shown[1]).toBe("A topic");
    expect(shown.slice(2).sort()).toEqual([`_threads/2026-11-17-a-topic/${basename(loadThread(dir).allPosts[0].path)}`, "_threads/2026-11-17-a-topic/README.md", "_threads/2026-11-17-a-topic/_agent/agreement.md"].sort());
    const loaded = loadThread(dir);
    expect(loaded).toMatchObject({ name: "A topic", summary: "What it is for.", nameSource: "opening", summarySource: "readme" });
    expect(loaded.attachment).toMatchObject({ kind: "post", value: spineOpen.post.id });
    expect(loaded.about.map((a) => a.raw)).toEqual(["note:@home//notes/why.md"]);
    // The opening without a parent but with a link: about, and attached_to carries the link for older readers.
    const linked = await post([], { new: "2026-11-17-linked", name: "Linked", about: "note:@home//notes/topic.md", "no-commit": true });
    expect(linked.exit, linked.err).toBe(0);
    expect(linked.data).toMatchObject({ about: ["note:@home//notes/topic.md"], attached_to: "note:@home//notes/topic.md", committed: false, reason: "--no-commit" });
    expect(loadThread(join(root, "_threads", "2026-11-17-linked")).attachment).toBeNull();
    expect((await post([], { new: "no-name" })).err).toContain("--name");
    expect((await post(["spine"], { new: "x", name: "X" })).err).toContain("takes no target");
    expect(existsSync(join(root, "_threads", "x"))).toBe(false);
  }, 60_000);
});
