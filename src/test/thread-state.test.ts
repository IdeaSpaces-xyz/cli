import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, createThread } from "../local/threads.js";
import { readThreadShare, shareLine } from "../local/thread-state.js";
import { threadsCommand } from "../commands/threads.js";

const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function space() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-post-state-"))); temp.push(dir);
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  process.env.HOME = dir;
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" }).trim();
function repo(dir: string) { git(dir, "init", "-q", "-b", "main"); }
function remoteFor(dir: string) {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "is-post-state-remote-"))); temp.push(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(dir, "remote", "add", "origin", bare);
}
/** A Thread with its opening post, as `threads new` leaves it. */
function opened(root: string, slug = "decision") {
  const thread = createThread(slug, "A decision", root);
  appendPost(thread.path, { body: "Opening", author: "Scout" });
  return thread;
}
const names = (thread: { path: string }) => readdirSync(thread.path).filter((f) => f.endsWith(".md") && f !== "README.md").sort();

describe("where a local post is", () => {
  it("says local only when the folder is not in a Git repository, and says why", () => {
    const root = space();
    const t = opened(root);
    const share = readThreadShare(t.path, names(t));
    expect([...share.states.values()]).toEqual(["local"]);
    expect(share.note).toMatch(/not in a Git repository/);
    expect(shareLine(share)).toMatch(/1 local only/);
  });

  it("walks a post from local only, to committed, to pushed, and back to committed when a newer one is not", () => {
    const root = space(); repo(root); remoteFor(root);
    const t = opened(root);
    const first = names(t)[0];
    // Untracked: only a file here.
    let share = readThreadShare(t.path, names(t));
    expect(share.states.get(first)).toBe("local");
    // Staged is still not committed.
    git(root, "add", "-A");
    expect(readThreadShare(t.path, names(t)).states.get(first)).toBe("local");
    git(root, "commit", "-qm", "Thread");
    // Committed, with no upstream: pushed is not known, and the line says so.
    share = readThreadShare(t.path, names(t));
    expect(share.states.get(first)).toBe("committed");
    expect(share.upstream).toBeNull();
    expect(share.note).toMatch(/no upstream/);
    git(root, "push", "-q", "-u", "origin", "main");
    share = readThreadShare(t.path, names(t));
    expect(share.states.get(first)).toBe("pushed");
    expect(share.upstream).toBe("origin/main");
    expect(share.note).toBeUndefined();
    // A second post: local only; committed once added; the first stays pushed throughout.
    const second = appendPost(t.path, { body: "Second", author: "Scout" });
    const secondName = names(t).find((n) => n !== first)!;
    share = readThreadShare(t.path, names(t));
    expect([share.states.get(first), share.states.get(secondName)]).toEqual(["pushed", "local"]);
    expect(share.counts).toEqual({ local: 1, committed: 0, pushed: 1 });
    git(root, "add", "-A"); git(root, "commit", "-qm", "Second");
    share = readThreadShare(t.path, names(t));
    expect([share.states.get(first), share.states.get(secondName)]).toEqual(["pushed", "committed"]);
    expect(shareLine(share)).toContain("1 committed (not pushed to origin/main)");
    expect(second.post.id).toMatch(/^msg_/);
  });

  it("flags a post file changed after it was committed", () => {
    const root = space(); repo(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    const file = names(t)[0];
    writeFileSync(join(t.path, file), readFileSync(join(t.path, file), "utf8") + "\nEdited later.\n");
    const share = readThreadShare(t.path, names(t));
    expect([...share.modified]).toEqual([file]);
    expect(shareLine(share)).toMatch(/changed after commit/);
  });

  it("reads only this folder's own post files: a changed Agreement or a child folder is not a post", () => {
    const root = space(); repo(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    appendFileSync(join(t.path, "_agent", "agreement.md"), "\nEdited Agreement.\n");
    mkdirSync(join(t.path, "child")); writeFileSync(join(t.path, "child", "2026-11-07T10-00-00-000Z-msg_x.md"), "---\nid: msg_x\n---\nx\n");
    const share = readThreadShare(t.path, names(t));
    expect([...share.modified]).toEqual([]);
    expect([...share.states.keys()]).toEqual(names(t));
  });

  it("says a staged edit and a staged rename of a committed post are changes after commit, and names only three of many", () => {
    const root = space(); repo(root);
    const t = opened(root);
    for (let i = 0; i < 4; i++) appendPost(t.path, { body: `Post ${i}`, author: "Scout", replyTo: ["latest"] });
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    for (const file of names(t).slice(0, 4)) appendFileSync(join(t.path, file), "\nEdit.\n");
    git(root, "add", "-A");
    const share = readThreadShare(t.path, names(t));
    expect(share.modified.size).toBe(4);
    expect(shareLine(share)).toMatch(/4 post files were changed after commit: .*, …;/);
  });

  /** A `git` that runs the real one except for the named verb, which fails; it also records the optional-locks setting it was given. */
  function failing(verb: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-fake-git-"))); temp.push(dir);
    const bin = join(dir, "git");
    writeFileSync(bin, `#!/bin/sh\necho "$GIT_OPTIONAL_LOCKS" >> "${join(dir, "locks")}"\nif [ "$1" = "${verb}" ]; then echo "fatal: simulated ${verb} failure" >&2; exit 128; fi\nexec "${execFileSync("which", ["git"], { encoding: "utf8" }).trim()}" "$@"\n`, { mode: 0o755 });
    return bin;
  }
  it("says it does not know, and gives no post a state, when Git cannot report the status", () => {
    const root = space(); repo(root);
    const t = opened(root);
    process.env.IDEASPACES_GIT_BIN = failing("status");
    try {
      const share = readThreadShare(t.path, names(t));
      expect(share.checked).toBe(false);
      expect(share.states.size).toBe(0);
      expect(shareLine(share)).toMatch(/^Post state unknown: Git could not report this Thread's status: fatal: simulated status failure\./);
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("calls an upstream it cannot compare committed, with the reason, never pushed; and never lets Git write while it reads", () => {
    const root = space(); repo(root); remoteFor(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread"); git(root, "push", "-q", "-u", "origin", "main");
    const bin = failing("diff");
    process.env.IDEASPACES_GIT_BIN = bin;
    try {
      const share = readThreadShare(t.path, names(t));
      expect(share.states.get(names(t)[0])).toBe("committed");
      expect(share.note).toMatch(/could not compare this Thread with origin\/main: fatal: simulated diff failure; committed posts are not checked for a push/);
      // Every Git call it made asked not to take optional locks, so reading a Thread never writes the index.
      const calls = readFileSync(join(bin, "..", "locks"), "utf8").split("\n").filter(Boolean);
      expect(calls.length).toBeGreaterThan(3);
      expect(new Set(calls)).toEqual(new Set(["0"]));
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("is in the open and post results: each post's state, the Thread's line, and a post that says it is not delivered", async () => {
    const root = space(); repo(root); remoteFor(root);
    opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread"); git(root, "push", "-q", "-u", "origin", "main");
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    let text = "";
    process.stdout.write = ((s: string) => { text += s; return true; }) as typeof process.stdout.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean> = {}) => { text = ""; expect(await threadsCommand.run(args, options, flags)).toBe(0); return JSON.parse(text); };
    try {
      const posted = await run(["post", "decision"], { message: "Not yet committed", author: "Scout" });
      expect(posted.state).toBe("local");
      const full = await run(["open", "decision"], { depth: "full" });
      expect(full.posts.map((p: { state: string }) => p.state)).toEqual(["pushed", "local"]);
      expect(full.thread.share).toMatchObject({ checked: true, upstream: "origin/main", counts: { local: 1, committed: 0, pushed: 1 } });
      expect((await run(["open", "decision"], { depth: "summary", limit: "5" })).posts.map((p: { state: string }) => p.state)).toEqual(["pushed", "local"]);
      expect((await run(["open", "decision"], { post: posted.id })).raw_post).toContain("Not yet committed");
      process.stdout.write = old;
      const human: string[] = [];
      process.stdout.write = ((s: string) => { human.push(s); return true; }) as typeof process.stdout.write;
      expect(await threadsCommand.run(["post", "decision"], { message: "Another", author: "Scout" }, { json: false, quiet: false, yes: false, help: false })).toBe(0);
      expect(await threadsCommand.run(["open", "decision"], { depth: "full" }, { json: false, quiet: false, yes: false, help: false })).toBe(0);
      const shown = human.join("");
      expect(shown).toContain("State: local only. The file is on this disk and not committed");
      expect(shown).toMatch(/Posts: 2 local only \(on this disk, not committed\), 1 pushed\./);
      expect(shown).toMatch(/· post · local only/);
      expect(shown).toMatch(/· post · pushed/);
    } finally { process.stdout.write = old; process.chdir(previous); }
  });
});
