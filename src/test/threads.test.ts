import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadPost } from "@ideaspaces/protocol";
import { acknowledge, appendPost, createThread, initWorktree, listLocal, loadThread, pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";
import { inboxCommand } from "../commands/inbox.js";
import { searchCommand } from "../commands/search.js";
import { push as genericPush } from "../git.js";

const temp: string[] = [];
const originalHome = process.env.HOME;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "is-local-thread-")); temp.push(dir);
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  return dir;
}
function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("local Threads", () => {
  it("opens cold, writes immutable posts, reconstructs two-parent joins and closes", () => {
    const root = fixture();
    process.env.HOME = root;
    const t = createThread("decision", "A decision: why", root);
    const first = appendPost(t.path, { body: "Starting", author: "Scout", name: "Start", summary: "First" });
    const left = appendPost(t.path, { body: "Left", author: "Backend", replyTo: [first.post.id] });
    const right = appendPost(t.path, { body: "Right", author: "Integrator", replyTo: [first.post.id] });
    const merge = appendPost(t.path, { body: "Joined", replyTo: [left.post.id, right.post.id] });
    const parsed = parseThreadPost(readFileSync(merge.path, "utf8"));
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") expect(parsed.post.references).toEqual([first.post.id, left.post.id, right.post.id]);
    const cold = loadThread(resolveLocalThread("decision", root));
    expect(cold.posts[0].id).toBe(first.post.id);
    expect(cold.posts.at(-1)?.id).toBe(merge.post.id);
    expect(readCursor(cold).size).toBe(0);
    acknowledge(cold, cold.posts);
    expect(readCursor(cold).size).toBe(4);
    const end = appendPost(t.path, { body: "Closed", kind: "closure" });
    expect(loadThread(t.path).closed).toBe(true);
    expect(() => appendPost(t.path, { body: "Too late" })).toThrow(/closed/);
    expect(readFileSync(first.path, "utf8")).toContain("Starting");
    expect(end.post.inReplyTo).toEqual([merge.post.id]);
    expect(listLocal(root)).toHaveLength(1);
  });

  it("closure joins all unmerged branch tips unless explicit parents are supplied", () => {
    const root = fixture();
    const t = createThread("decision", "Decision", root);
    const first = appendPost(t.path, { body: "Root" });
    const left = appendPost(t.path, { body: "Left", replyTo: [first.post.id] });
    const right = appendPost(t.path, { body: "Right", replyTo: [first.post.id] });
    const end = appendPost(t.path, { body: "Closed", kind: "closure" });
    expect(new Set(end.post.inReplyTo)).toEqual(new Set([left.post.id, right.post.id]));
  });

  it("rejects traversal, symlinks, malformed posts, duplicate ids, and invalid Maps before write", () => {
    const root = fixture(); const t = createThread("decision", "Decision", root);
    expect(() => createThread("../outside", "Bad", root)).toThrow(/slug/);
    expect(() => resolveLocalThread("../../outside", root)).toThrow();
    expect(() => appendPost(t.path, { body: "No", replyTo: ["missing"] })).toThrow(/reply-to/);
    expect(() => appendPost(t.path, { body: "No", map: { roots: [{ sha: "HEAD" }], members: [] } })).toThrow(/Map/);
    expect(readdirSync(t.path).filter((p) => p.startsWith("20"))).toEqual([]);
    writeFileSync(join(t.path, "bad.md"), "---\nkind: post\n---\nMissing id");
    expect(() => loadThread(t.path)).toThrow(/Invalid post/);
    rmSync(join(t.path, "bad.md"));
    const first = appendPost(t.path, { body: "First" });
    writeFileSync(join(t.path, "duplicate.md"), readFileSync(first.path));
    expect(() => loadThread(t.path)).toThrow(/Duplicate post id/);
    rmSync(join(t.path, "duplicate.md"));
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(root, "_threads", "escape"));
    expect(() => resolveLocalThread("escape", root)).toThrow(/symlink/);
    symlinkSync(first.path, join(t.path, "linked.md"));
    expect(() => loadThread(t.path)).toThrow(/Unexpected thread entry/);
  });

  it("cold CLI read respects the rung and advances the cursor only on explicit ack", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("decision", "Decision", root);
    appendPost(thread.path, { body: "Private body", summary: "Public summary", author: "Agent A" });
    const old = process.cwd(); process.chdir(root);
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((s: string) => { output += s; return true; }) as typeof process.stdout.write;
    try {
      const flags = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["open", "decision"], { depth: "name", new: true }, flags)).toBe(0);
      expect(output).not.toContain("Private body"); output = "";
      expect(await threadsCommand.run(["open", "decision"], { depth: "summary", new: true }, flags)).toBe(0);
      expect(output).toContain("Public summary"); expect(output).not.toContain("Private body");
      expect(readCursor(loadThread(thread.path)).size).toBe(0); output = "";
      expect(await threadsCommand.run(["open", "decision"], { depth: "full", new: true, ack: true }, flags)).toBe(0);
      expect(output).toContain("Private body"); expect(readCursor(loadThread(thread.path)).size).toBe(1); output = "";
      expect(await threadsCommand.run(["open", "decision"], { depth: "summary", new: true }, flags)).toBe(0);
      expect(JSON.parse(output).posts).toEqual([]);
    } finally { process.stdout.write = original; process.chdir(old); }
  });

  it("dispatches local new/post/list/render/close and aware search without a login", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    let text = "";
    process.stdout.write = ((s: string) => { text += s; return true; }) as typeof process.stdout.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (command: typeof threadsCommand | typeof searchCommand, args: string[], options: Record<string, string | boolean> = {}) => {
      text = ""; expect(await command.run(args, options, flags)).toBe(0); return JSON.parse(text);
    };
    try {
      await run(threadsCommand, ["new", "decision"], { about: "Decision" });
      const first = await run(threadsCommand, ["post", "decision"], { message: "Cold keyword", author: "Agent A" });
      const second = await run(threadsCommand, ["post", "decision"], { message: "Other", author: "Agent B", "reply-to": first.id });
      const joined = await run(threadsCommand, ["post", "decision"], { message: "Join", "reply-to": `${first.id},${second.id}` });
      expect(loadThread(join(root, "_threads", "decision")).posts.at(-1)?.inReplyTo).toEqual([first.id, second.id]);
      expect(joined.kind).toBe("post");
      expect((await run(threadsCommand, ["list"])).threads[0].source).toBe("local");
      expect((await run(threadsCommand, ["render", "decision"])).timeline).toHaveLength(3);
      expect((await run(searchCommand, ["Cold"], { threads: true })).results[0].path).toContain("_threads/decision/");
      expect((await run(searchCommand, ["Cold"])).results).toHaveLength(0);
      await run(threadsCommand, ["close", "decision"], { message: "Closing" });
      expect(loadThread(join(root, "_threads", "decision")).closed).toBe(true);
    } finally { process.chdir(previous); process.stdout.write = old; }
  });

  it("keeps the old inbox name as a noisy one-release alias", () => {
    expect(inboxCommand.description).toContain("Legacy");
    expect(threadsCommand.examples?.some((x) => x.includes("read x_"))).toBe(true);
  });

  it("dispatches init and push only to an explicit team remote", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    git(root, "add", "_agent/agreement.md"); git(root, "commit", "-m", "init");
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    try {
      expect(await threadsCommand.run(["init"], {}, flags)).toBe(0);
      expect(git(join(root, "_threads"), "branch", "--show-current")).toBe("threads");
      const t = createThread("decision", "Decision", root);
      appendPost(t.path, { body: "Team", author: "Agent" });
      git(join(root, "_threads"), "add", "decision");
      git(join(root, "_threads"), "commit", "-m", "post");
      expect(await threadsCommand.run(["push"], {}, flags)).toBe(1);
      const bare = join(root, "team.git"); git(root, "init", "--bare", bare);
      git(root, "remote", "add", "team", bare);
      expect(await threadsCommand.run(["push"], { remote: "team" }, flags)).toBe(0);
      expect(git(root, "ls-remote", "team", "refs/heads/threads")).toContain("refs/heads/threads");
    } finally { process.stdout.write = old; process.chdir(previous); }
  });

  it("resolves a separate orphan worktree at the authored commit, not HEAD", async () => {
    const root = fixture();
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
    git(root, "add", "_agent/agreement.md"); git(root, "commit", "-m", "init");
    const main = git(root, "rev-parse", "HEAD");
    const worktree = initWorktree(root);
    const t = createThread("decision", "Decision", root);
    const one = appendPost(t.path, { body: "At pin", author: "Agent A" });
    git(worktree, "add", "decision"); git(worktree, "commit", "-m", "first post");
    const pin = git(worktree, "rev-parse", "HEAD");
    const two = appendPost(t.path, { body: "After pin", author: "Agent B" });
    const map = join(root, "selection.json");
    writeFileSync(map, JSON.stringify({ map: {
      roots: [{ repo: "https://ideaspaces.xyz/repos/n_0123456789abcdef01234567", sha: pin }],
      members: [{ root: 0, position: `_threads/decision/${one.post.path}`, depth: "full" }],
    } }));
    const before = process.cwd(); process.chdir(root);
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((s: string) => { output += s; return true; }) as typeof process.stdout.write;
    try {
      const flags = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["open", "decision"], { map, member: "0", depth: "full" }, flags)).toBe(0);
      expect(JSON.parse(output).pinned).toContain("At pin");
      output = "";
      expect(await threadsCommand.run(["open", "decision"], { pin, position: `_threads/decision/${one.post.path}`, depth: "full" }, flags)).toBe(0);
      expect(JSON.parse(output).pinned).toContain("At pin");
      createThread("other", "Other", root);
      expect(await threadsCommand.run(["open", "other"], { map, member: "0" }, flags)).toBe(1);
    } finally { process.stdout.write = original; process.chdir(before); }
    git(worktree, "add", "decision"); git(worktree, "commit", "-m", "second post");
    expect(readPinnedThreadMember(root, pin, `_threads/decision/${one.post.path}`)).toContain("At pin");
    expect(() => readPinnedThreadMember(root, pin, `_threads/decision/${two.post.path}`)).toThrow(/refusing working-tree HEAD fallback/);
    expect(() => readPinnedThreadMember(root, main, `_threads/decision/${one.post.path}`)).toThrow(/fallback/);
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => readPinnedThreadMember(root, pin, `_threads/decision/${one.post.path}`)).toThrow(/git not found/);
    } finally { process.env.PATH = oldPath; }
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("/_threads/");
    git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
    expect(() => pushWorktree(root, "origin")).toThrow(/GitHub|origin/);
    git(root, "remote", "add", "enterprise", "ssh://git@code.example.test/team/private.git");
    expect(() => pushWorktree(root, "enterprise")).toThrow(/unknown hosts/);
    expect(() => genericPush(worktree)).toThrow(/Private threads branch/);
    git(root, "worktree", "move", worktree, join(root, "private-discussion"));
    expect(() => genericPush(join(root, "private-discussion"))).toThrow(/Private threads branch/);
    const bare = join(root, "team.git");
    git(root, "init", "--bare", bare);
    git(root, "remote", "add", "team", bare);
    // The explicit command expects the documented _threads/ mount; reattach it
    // after verifying generic push remains guarded under a moved path.
    git(root, "worktree", "move", join(root, "private-discussion"), worktree);
    expect(pushWorktree(root, "team")).toBe("team");
    expect(git(root, "ls-remote", "team", "refs/heads/threads")).toContain("refs/heads/threads");
  });
});
