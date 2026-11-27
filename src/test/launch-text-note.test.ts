import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";
import { assembleLaunchText } from "../local/launch-text.js";
import { appendPost as appendPostNow, createThread, loadThread } from "../local/threads.js";

/**
 * A launch from a post of a Thread whose Map names Notes and no post (Desktop Bugs msg_a0b39905,
 * msg_1d2f1a7d, msg_ddf7fec3, msg_ff592bdf). Two shapes from Home: a Thread the app opens on a Note
 * (`threads new --from-note`, the opening post `about:` that Note, later a second Note written into
 * the Thread's own notes/), and How we ship's, whose snapshot names a backlog Map at full and a README
 * at summary in another repository. Each launches with a Note as the Note; when nothing says which,
 * the refusal lists the members and `--member` on a Note works.
 */
vi.setConfig({ testTimeout: 90_000 });

const ROOT_ID = "n_0123456789abcdef01234567";
const OTHER_ID = "n_89abcdef0123456789abcdef";
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

let lastStamp = 0;
const appendPost: typeof appendPostNow = (dir, options) => {
  while (Date.now() <= lastStamp) { /* a fresh millisecond, so "newest" is the last written */ }
  lastStamp = Date.now();
  return appendPostNow(dir, options);
};

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

function repo(dir: string, id: string, name: string) {
  mkdirSync(join(dir, "_agent"), { recursive: true });
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: ${name}\nsummary: Test\nroot_node_id: ${id}\n---\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test");
  git(dir, "add", "_agent/agreement.md"); git(dir, "commit", "-q", "-m", "init");
}

function space(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lt-note-"))); temp.push(dir);
  process.env.HOME = dir;
  repo(dir, ROOT_ID, "Home");
  return dir;
}

function note(dir: string, position: string, name: string, body: string) {
  mkdirSync(join(dir, position, ".."), { recursive: true });
  writeFileSync(join(dir, position), `---\nname: ${name}\nsummary: ${name}, in short\n---\n\n${body}\n`);
}

async function fromNote(dir: string, slug: string, position: string): Promise<string> {
  const before = process.cwd(); process.chdir(dir);
  const stdout = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    const code = await threadsCommand.run(["new", slug], { "from-note": position }, { json: true, quiet: true, yes: false, help: false });
    expect(code).toBe(0);
  } finally { process.stdout.write = stdout; process.chdir(before); }
  expect(JSON.parse(out).about).toEqual([`note:@${ROOT_ID}//${position}`]);
  return join(dir, "_threads", slug);
}

/** The long letter to Jānis: opened on a Note, an ask in reply, then a Note written into the Thread and a Map of both. */
async function letterThread() {
  const dir = space();
  note(dir, "Ideas/letter.md", "The long letter", "LETTER-BODY: what the Thread is about.");
  const thread = await fromNote(dir, "letter", "Ideas/letter.md");
  const opening = loadThread(thread).thread_id;
  const ask = appendPost(thread, { body: "For UI/UX and AX: one post each.", author: "Explorer", replyTo: [opening] });
  return { dir, thread, opening, ask: ask.post.id };
}

describe("threads launch-text from a Thread whose Map names Notes", () => {
  it("launches from a post of a Thread opened on a Note, with the Note its opening post is about", async () => {
    const { dir, thread, ask } = await letterThread();
    const result = await assembleLaunchText({ thread, post: ask, cwd: dir });
    expect(result.note).toMatchObject({ kind: "note", member: 0, by: "about", position: "Ideas/letter.md" });
    expect(result.text.split("LETTER-BODY").length - 1).toBe(1);
    expect(result.text).toContain("[Note — member [0] of the Map above");
    expect(result.text).toContain("[End Note]");
  });

  it("still takes the Note it is about after a second Note is written into the Thread's notes/", async () => {
    const { dir, thread, opening } = await letterThread();
    const first = git(dir, "rev-parse", "HEAD");
    note(dir, "_threads/letter/notes/vestule.md", "Vēstule", "VESTULE-BODY: the second Note.");
    git(dir, "add", "-f", "_threads/letter/notes/vestule.md"); git(dir, "commit", "-q", "-m", "vestule");
    const second = git(dir, "rev-parse", "HEAD");
    const map = { roots: [{ root_node_id: ROOT_ID, sha: first }, { root_node_id: ROOT_ID, sha: second }], members: [
      { root: 0, position: "Ideas/letter.md", depth: "full", name: "The long letter" },
      { root: 1, position: "_threads/letter/notes/vestule.md", depth: "full", name: "Vēstule" },
    ] };
    const both = appendPost(thread, { body: "Two Notes now.", author: "Explorer", replyTo: [opening], map });
    const card = appendPost(thread, { body: "Card for Scout.", author: "Explorer", replyTo: [both.post.id] });
    const result = await assembleLaunchText({ thread, post: card.post.id, cwd: dir });
    expect(result.note).toMatchObject({ kind: "note", member: 0, by: "about", position: "Ideas/letter.md" });
    expect(result.text).toContain("LETTER-BODY");
    expect(result.text).toContain("VESTULE-BODY");
    // The refusal's way out works: a Note in the Thread's own notes/ is a Note, not a post.
    const asked = await assembleLaunchText({ thread, post: card.post.id, member: "1", cwd: dir });
    expect(asked.note).toMatchObject({ kind: "note", member: 1, by: "asked", position: "_threads/letter/notes/vestule.md" });
  });

  it("launches from How we ship's shape: the one member at full, in another repository, is the Note", async () => {
    const dir = space();
    const ship = join(dir, "knowledge", "how-we-ship");
    mkdirSync(ship, { recursive: true });
    repo(ship, OTHER_ID, "How we ship");
    note(ship, "backlog.map.md", "Backlog", "BACKLOG-BODY: the rank.");
    note(ship, "README.md", "How we ship", "README-BODY");
    git(ship, "add", "-A"); git(ship, "commit", "-q", "-m", "backlog");
    const pin = git(ship, "rev-parse", "HEAD");
    const thread = createThread("how-we-ship", "How we ship", dir).path;
    const opening = appendPost(thread, { body: "We ship at the pace agents can build.", author: "d-pm" });
    const review = appendPost(thread, { body: "Backlog review 1.", author: "d-pm", kind: "snapshot", replyTo: [opening.post.id], map: { roots: [{ root_node_id: OTHER_ID, sha: pin }], members: [
      { root: 0, position: "backlog.map.md", depth: "full", summary: "The backlog itself" },
      { root: 0, position: "README.md", depth: "summary", summary: "How we ship" },
    ] } });
    const ask = appendPost(thread, { body: "A local internal build.", author: "d-pm", replyTo: [review.post.id] });
    const result = await assembleLaunchText({ thread, post: ask.post.id, cwd: dir });
    expect(result.note).toMatchObject({ kind: "note", member: 0, by: "only-full", position: "backlog.map.md" });
    expect(result.text).toContain("BACKLOG-BODY");
  });

  it("refuses with the members listed when several Notes are at full and none is the Thread's about, and --member works", async () => {
    const dir = space();
    note(dir, "docs/a.md", "A", "A-BODY");
    note(dir, "docs/b.md", "B", "B-BODY");
    git(dir, "add", "docs"); git(dir, "commit", "-q", "-m", "docs");
    const pin = git(dir, "rev-parse", "HEAD");
    const thread = createThread("plain", "Plain", dir).path;
    const opening = appendPost(thread, { body: "Two docs.", author: "d-pm", map: { roots: [{ root_node_id: ROOT_ID, sha: pin }], members: [
      { root: 0, position: "docs/a.md", depth: "full" }, { root: 0, position: "docs/b.md", depth: "full" }, { root: 0, position: ".", depth: "summary" },
    ] } });
    // A root's own folder is listed by its root, not as a bare "." (msg_a0b39905).
    await expect(assembleLaunchText({ thread, post: opening.post.id, cwd: dir })).rejects.toThrow(new RegExp(`--member <ordinal>[\\s\\S]*\\[0\\] docs/a\\.md \\(full\\)[\\s\\S]*\\[1\\] docs/b\\.md \\(full\\)[\\s\\S]*\\[2\\] @${ROOT_ID}//\\. \\(summary\\)`));
    const asked = await assembleLaunchText({ thread, post: opening.post.id, member: "1", cwd: dir });
    expect(asked.note).toMatchObject({ kind: "note", member: 1, by: "asked", position: "docs/b.md" });
    expect(asked.text).toContain("B-BODY");
  });
});
