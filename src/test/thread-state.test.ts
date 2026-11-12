import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, createThread } from "../local/threads.js";
import { readThreadShare, shareLine } from "../local/thread-state.js";
import { threadsCommand } from "../commands/threads.js";
import { GIT_INTEGRATION_TIMEOUT } from "./git-integration-timeout.js";

// Substitute just the failing executable, keeping real Git for all other calls.
// A POSIX wrapper is not an executable on native Windows. The sentinel paths
// intentionally intercept spawnSync; a production change of primitive must update this fixture.
const fakeGit = vi.hoisted(() => new Map<string, { verb: string; needle: string; dir: string; slow?: boolean }>());
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fs = await import("node:fs");
  return { ...actual, spawnSync: (bin: string, args: string[], options: any) => {
    const stub = fakeGit.get(bin);
    if (!stub) return actual.spawnSync(bin, args, options);
    fs.appendFileSync(join(stub.dir, "locks"), `${options?.env?.GIT_OPTIONAL_LOCKS ?? ""}\n`);
    if (stub.slow && ["status", "diff", "ls-tree"].includes(args[0])) {
      // A real blocking native child, subject to the production timeout option.
      return actual.spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], options);
    }
    if (args[0] === stub.verb && args.join(" ").includes(stub.needle)) {
      return { status: 128, signal: null, stdout: "", stderr: `fatal: simulated ${stub.verb} failure\n`, pid: 0, output: [] };
    }
    return actual.spawnSync("git", args, options); // CI supplies real Git on PATH.
  } };
});

const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { fakeGit.clear(); process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  }, GIT_INTEGRATION_TIMEOUT); // Real commits/push and seven state reads took 5.44s on Windows CI.

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

  it("never calls a post pushed that Git is not holding: one ignored by .gitignore, and a staged rename's new name", () => {
    const root = space(); repo(root); remoteFor(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread"); git(root, "push", "-q", "-u", "origin", "main");
    // An ignored post: invisible to `git status`, in neither HEAD nor the upstream.
    writeFileSync(join(root, ".gitignore"), "*-ignored.md\n");
    const second = appendPost(t.path, { body: "Hidden", author: "Scout", replyTo: ["latest"] });
    const ignored = second.path.replace(/\.md$/, "-ignored.md");
    renameSync(second.path, ignored);
    expect(git(root, "status", "--porcelain", "--", "_threads")).not.toContain("ignored");
    const first = names(t).find((n) => !n.endsWith("-ignored.md"))!;
    git(t.path, "mv", first, first.replace(/\.md$/, "-moved.md"));
    const share = readThreadShare(t.path, names(t));
    expect(share.states.get(names(t).find((n) => n.endsWith("-ignored.md"))!)).toBe("local");
    expect(share.states.get(names(t).find((n) => n.endsWith("-moved.md"))!)).toBe("local");
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

  /** A `git` that runs the real one except for the named verb (when its arguments also contain `needle`), which fails; it records the optional-locks setting it was given. */
  function failing(verb: string, needle = ""): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-fake-git-"))); temp.push(dir);
    const bin = join(dir, "git-fixture");
    fakeGit.set(bin, { verb, needle, dir });
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

  it("reads a failed ls-tree as unknown, never as local: a post that is committed must not read as only on this disk", () => {
    const root = space(); repo(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    process.env.IDEASPACES_GIT_BIN = failing("ls-tree");
    try {
      const share = readThreadShare(t.path, names(t));
      expect(share.checked).toBe(false);
      expect(share.states.size).toBe(0);
      expect(share.counts).toEqual({ local: 0, committed: 0, pushed: 0 });
      expect(shareLine(share)).toBe("Post state unknown: Git could not list what is committed: fatal: simulated ls-tree failure.");
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("reads a HEAD it cannot verify as unknown, and no HEAD yet as local", () => {
    const root = space(); repo(root);
    const t = opened(root);
    // A repository with no commit has no HEAD: every post is only a file here.
    let share = readThreadShare(t.path, names(t));
    expect(share.checked).toBe(true);
    expect([...share.states.values()]).toEqual(["local"]);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    process.env.IDEASPACES_GIT_BIN = failing("rev-parse", "--verify");
    try {
      share = readThreadShare(t.path, names(t));
      expect(share.checked).toBe(false);
      expect(shareLine(share)).toBe("Post state unknown: Git could not read HEAD: fatal: simulated rev-parse failure.");
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("reads a Git it cannot run as unknown, and only Git's own 'not a repository' as local", () => {
    const root = space(); repo(root);
    const t = opened(root);
    process.env.IDEASPACES_GIT_BIN = join(root, "no-such-git");
    try {
      const share = readThreadShare(t.path, names(t));
      expect(share.checked).toBe(false);
      expect(shareLine(share)).toMatch(/^Post state unknown: Git could not be asked/);
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("never reads a post in a merge conflict as pushed or committed: it is local, and the line names it", () => {
    const root = space(); repo(root); remoteFor(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread"); git(root, "push", "-q", "-u", "origin", "main");
    const file = names(t)[0];
    git(root, "checkout", "-q", "-b", "other");
    appendFileSync(join(t.path, file), "\nOther side.\n"); git(root, "commit", "-qam", "Other");
    git(root, "checkout", "-q", "main");
    appendFileSync(join(t.path, file), "\nMain side.\n"); git(root, "commit", "-qam", "Main");
    expect(() => git(root, "merge", "other")).toThrow();
    expect(git(root, "status", "--porcelain", "--", "_threads")).toMatch(/^UU /m);
    const share = readThreadShare(t.path, names(t));
    expect(share.states.get(file)).toBe("local");
    expect([...share.unmerged]).toEqual([file]);
    expect(shareLine(share)).toMatch(/1 post file is in a merge conflict and counted as local only: /);
  });

  it("stops waiting on a hung Git after the allowance in all, and says unknown: six slow calls cannot add up to minutes", () => {
    const root = space(); repo(root);
    const t = opened(root);
    git(root, "add", "-A"); git(root, "commit", "-qm", "Thread");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-slow-git-"))); temp.push(dir);
    const bin = join(dir, "slow-git-fixture");
    fakeGit.set(bin, { dir, verb: "", needle: "", slow: true });
    process.env.IDEASPACES_GIT_BIN = bin;
    try {
      const started = Date.now();
      const share = readThreadShare(t.path, names(t), 700);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(share.checked).toBe(false);
      expect(shareLine(share)).toBe("Post state unknown: Git could not report this Thread's status: Git did not answer within 0.7 s.");
    } finally { delete process.env.IDEASPACES_GIT_BIN; }
  });

  it("tells a post made outside any Git repository that there is nothing to commit or push, not to commit and push it", async () => {
    const root = space();
    createThread("decision", "A decision", root);
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    const out: string[] = [];
    process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
    try {
      expect(await threadsCommand.run(["post", "decision"], { message: "Outside", author: "Scout" }, { json: false, quiet: false, yes: false, help: false })).toBe(0);
      const text = out.join("");
      expect(text).toContain("State: local only. This folder is not in a Git repository, so there is nothing to commit or push here");
      expect(text).not.toContain("commit and push it");
    } finally { process.stdout.write = old; process.chdir(previous); }
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
      const posted = await run(["post", "decision"], { message: "Not yet committed", author: "Scout", "no-commit": true });
      expect(posted).toMatchObject({ state: "local", committed: false, reason: "--no-commit" });
      const full = await run(["open", "decision"], { depth: "full" });
      expect(full.posts.map((p: { state: string }) => p.state)).toEqual(["pushed", "local"]);
      expect(full.thread.share).toMatchObject({ checked: true, upstream: "origin/main", counts: { local: 1, committed: 0, pushed: 1 } });
      expect((await run(["open", "decision"], { depth: "summary", limit: "5" })).posts.map((p: { state: string }) => p.state)).toEqual(["pushed", "local"]);
      expect((await run(["open", "decision"], { post: posted.id })).raw_post).toContain("Not yet committed");
      process.stdout.write = old;
      const human: string[] = [];
      process.stdout.write = ((s: string) => { human.push(s); return true; }) as typeof process.stdout.write;
      expect(await threadsCommand.run(["post", "decision"], { message: "Another", author: "Scout", "no-commit": true }, { json: false, quiet: false, yes: false, help: false })).toBe(0);
      expect(await threadsCommand.run(["open", "decision"], { depth: "full" }, { json: false, quiet: false, yes: false, help: false })).toBe(0);
      const shown = human.join("");
      expect(shown).toContain("State: local only. Written, not committed (--no-commit)");
      expect(shown).toMatch(/Posts: 2 local only \(on this disk, not committed\), 1 pushed\./);
      expect(shown).toMatch(/· post · local only/);
      expect(shown).toMatch(/· post · pushed/);
    } finally { process.stdout.write = old; process.chdir(previous); }
  });
});

describe("a local author is a claim", () => {
  it("is said once for the Thread, beside every author, and in the JSON a tool reads", async () => {
    const root = space();
    const t = opened(root);
    appendPost(t.path, { body: "I decided this.", author: "The human", replyTo: ["latest"] });
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    let text = "";
    process.stdout.write = ((s: string) => { text += s; return true; }) as typeof process.stdout.write;
    const run = async (global: { json: boolean; quiet: boolean }, options: Record<string, string | boolean>) => { text = ""; expect(await threadsCommand.run(["open", "decision"], options, { ...global, yes: false, help: false })).toBe(0); return text; };
    try {
      const json = JSON.parse(await run({ json: true, quiet: true }, { depth: "full" }));
      expect(json.thread).toMatchObject({ author_trust: "claimed", author_note: expect.stringMatching(/claims by whoever wrote the file, not verified identities/) });
      const human = await run({ json: false, quiet: false }, { depth: "full" });
      expect(human).toContain("Author names here are claims by whoever wrote the file, not verified identities.");
      expect(human).toContain("· claimed by The human ·");
      expect(human).not.toMatch(/· The human ·/);
      const summary = await run({ json: false, quiet: false }, { depth: "summary", limit: "5" });
      expect(summary).toContain("claimed by The human");
    } finally { process.stdout.write = old; process.chdir(previous); }
  });
});
