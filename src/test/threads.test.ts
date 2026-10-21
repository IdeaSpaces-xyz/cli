import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadPost } from "@ideaspaces/protocol";
import { acknowledge, appendPost, createThread, initWorktree, listLocal, loadThread, pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread, threadBase, resolveThreadParent, computeBranches } from "../local/threads.js";
import { threadsCommand, threadFlagError } from "../commands/threads.js";
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
    expect(() => appendPost(t.path, { body: "Late mark", kind: "mark", mark: "claimed", replyTo: [first.post.id] })).toThrow(/closed/);
    expect(readFileSync(first.path, "utf8")).toContain("Starting");
    expect(end.post.inReplyTo).toEqual([merge.post.id]);
    expect(listLocal(root)).toHaveLength(1);
  });

  it("does not reinterpret lookalike _threads paths as a Space", () => {
    const root = fixture();
    const nested = join(root, "_threads-archive", "work");
    mkdirSync(nested, { recursive: true });
    expect(threadBase(nested)).toBe(realpathSync(root));
    const thread = createThread("decision", "Decision", root);
    expect(threadBase(thread.path)).toBe(realpathSync(thread.path)); // Thread Agreement still has its own scope
    expect(resolveThreadParent(thread.path)).toBeNull();
  });

  it("does not hide an unreadable parent post or follow a symlinked attachment", () => {
    const root = fixture();
    const parent = createThread("parent", "Parent", root);
    const post = appendPost(parent.path, { body: "Parent" });
    const child = createThread("child", "Child", root);
    appendPost(child.path, { body: "Child opening" });
    const agreement = join(child.path, "_agent", "agreement.md");
    writeFileSync(agreement, `---\nname: Child\nattached_to: _threads/parent/${post.post.path}\n---\n`);
    expect(resolveThreadParent(child.path)?.id).toBe(post.post.id);
    symlinkSync(post.path, join(parent.path, "alias.md"));
    writeFileSync(agreement, "---\nname: Child\nattached_to: _threads/parent/alias.md\n---\n");
    expect(() => resolveThreadParent(child.path)).toThrow(/Unexpected thread entry/);
    rmSync(join(parent.path, "alias.md"));
    writeFileSync(agreement, "---\nname: Child\nattached_to: msg_unknown\n---\n");
    expect(resolveThreadParent(child.path)).toEqual({ attached_to: "msg_unknown", status: "unresolved" });
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

  it("projects branches from DAG edges when legacy replies omit ancestor references", () => {
    const root = fixture(); const t = createThread("branches", "Branches", root);
    const first = appendPost(t.path, { body: "Root" });
    const a = appendPost(t.path, { body: "A", replyTo: [first.post.id] });
    const b = appendPost(t.path, { body: "B", replyTo: [first.post.id] });
    const joinPost = appendPost(t.path, { body: "Join", replyTo: [a.post.id, b.post.id] });
    for (const path of [a.path, b.path, joinPost.path]) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/references:\n(?:  - .*\n)+/, ""));
    }
    const branches = computeBranches(loadThread(t.path).posts);
    expect(branches.map((branch) => branch.root_id).sort()).toEqual([a.post.id, b.post.id].sort());
    expect(branches.map((branch) => branch.tip_id)).toEqual([joinPost.post.id, joinPost.post.id]);
    expect(branches.map((branch) => branch.count)).toEqual([2, 2]); // join belongs to both
    appendPost(t.path, { body: "Legacy second root", replyTo: [] });
    expect(computeBranches(loadThread(t.path).posts)).toHaveLength(3);
  });

  it("rejects traversal, symlinks, malformed posts, duplicate ids, and invalid Maps before write", () => {
    const root = fixture(); const t = createThread("decision", "Decision", root);
    expect(() => createThread("../outside", "Bad", root)).toThrow(/slug/);
    expect(() => resolveLocalThread("../../outside", root)).toThrow();
    expect(() => appendPost(t.path, { body: "No", replyTo: ["missing"] })).toThrow(/reply-to/);
    expect(() => appendPost(t.path, { body: "No", replyTo: ["latest"] })).toThrow(/no posts/);
    expect(() => appendPost(t.path, { body: "No", tags: ["x".repeat(201)] })).toThrow(/--tags/);
    expect(() => appendPost(t.path, { body: "No", tags: ["bad\nnewline"] })).toThrow(/--tags/);
    expect(() => appendPost(t.path, { body: "No", tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) })).toThrow(/20 distinct/);
    expect(() => appendPost(t.path, { body: "No", map: { roots: [{ sha: "HEAD" }], members: [] } })).toThrow(/Map/);
    expect(() => appendPost(t.path, { body: "No", map: { roots: [{ root_node_id: "n_0123456789abcdef01234567" }], members: [] } })).toThrow(/root 0.*no SHA/);
    expect(() => appendPost(t.path, { body: "No", map: { roots: [{ root_node_id: "n_0123456789abcdef01234567", sha: "a".repeat(40) }], members: [{ root: 0, position: "." }] } })).toThrow(/depth ceiling/);
    expect(readdirSync(t.path).filter((p) => p.startsWith("20"))).toEqual([]);
    writeFileSync(join(t.path, "bad.md"), "---\nkind: post\n---\nMissing id");
    expect(loadThread(t.path).unreadablePosts).toContain("_threads/decision/bad.md");
    expect(() => appendPost(t.path, { body: "Cannot branch without opening" })).toThrow(/Opening post .*bad\.md.*repair it/);
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
    renameSync(join(root, "_threads"), join(root, "physical-threads"));
    symlinkSync("physical-threads", join(root, "_threads"));
    expect(() => resolveLocalThread("decision", root)).toThrow(/symlink/);
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
      const opened = await run(threadsCommand, ["new", "decision"], { about: "Decision" });
      const opening = loadThread(join(root, "_threads", "decision")).posts[0];
      expect(opened.opening_post_id).toBe(opening.id);
      expect(opened.thread_id).toBe(opening.id);
      expect((await run(threadsCommand, ["open", "decision"], { depth: "name" })).thread.thread_id).toBe(opening.id);
      expect((await run(threadsCommand, ["list"], { depth: "name" })).threads[0].thread_id).toBe(opening.id);
      expect(opened.date).toBe(opening.date);
      expect(readFileSync(join(root, "_threads", "decision", opening.path), "utf8")).toContain(`date: ${opening.date}`);
      expect((await run(threadsCommand, ["list"], { new: true })).threads[0].count).toBe(1);
      expect((await run(threadsCommand, ["open", "decision"], { depth: "summary", new: true, ack: true })).posts[0].date).toBe(opening.date);
      expect((await run(threadsCommand, ["list"], { new: true })).threads).toEqual([]);
      const first = await run(threadsCommand, ["post", "decision"], { message: "Cold keyword", author: "Agent A" });
      const second = await run(threadsCommand, ["post", "decision"], { message: "Other", author: "Agent B", "reply-to": first.id });
      const joined = await run(threadsCommand, ["post", "decision"], { message: "Join", "reply-to": `${first.id},${second.id}` });
      expect(loadThread(join(root, "_threads", "decision")).posts.at(-1)?.inReplyTo).toEqual([first.id, second.id]);
      expect(joined.kind).toBe("post");
      const listed = (await run(threadsCommand, ["list"])).threads[0];
      expect(listed.source).toBe("local");
      expect(listed.thread_id).toBe(opening.id);
      expect(listed.latest_activity_at).toBe(loadThread(join(root, "_threads", "decision")).posts.at(-1)?.date);
      expect((await run(threadsCommand, ["render", "decision"])).timeline).toHaveLength(4);
      expect((await run(searchCommand, ["Cold"], { threads: true })).results[0].path).toContain("_threads/decision/");
      expect((await run(searchCommand, ["Cold"])).results).toHaveLength(0);
      await run(threadsCommand, ["close", "decision"], { message: "Closing" });
      expect(loadThread(join(root, "_threads", "decision")).closed).toBe(true);
      writeFileSync(join(root, "_threads", "decision", "invalid.md"), "---\nkind: post\n---\nMissing id");
      text = "";
      expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
      expect(JSON.parse(text).local_complete).toBe(false);
      expect(await searchCommand.run(["Cold"], { threads: true }, flags)).toBe(0);
    } finally { process.chdir(previous); process.stdout.write = old; }
  });

  it("locates an opening id after a move and refuses ambiguous copies", async () => {
    const from = fixture(); const to = fixture(); process.env.HOME = from;
    const empty = createThread("empty", "Empty", from);
    expect(loadThread(empty.path).thread_id).toBeNull();
    const thread = createThread("before", "Before", from);
    const opening = appendPost(thread.path, { body: "Opening" }).post.id;
    const old = process.cwd(); process.chdir(from);
    const write = process.stdout.write;
    let out = "";
    process.stdout.write = ((value: string) => { out += value; return true; }) as typeof process.stdout.write;
    const run = async (roots: string[]) => { out = ""; expect(await threadsCommand.run(["locate", opening, ...roots], {}, { json: true, quiet: true, yes: false, help: false })).toBe(0); return JSON.parse(out); };
    try {
      expect((await run([from, to])).status).toBe("found");
      expect((await run([from])).matches).toHaveLength(1);
      const moved = join(to, "_threads", "after"); mkdirSync(join(to, "_threads")); renameSync(thread.path, moved);
      expect(loadThread(moved).thread_id).toBe(opening);
      expect((await run([from, to])).matches[0].path).toBe(loadThread(moved).path);
      expect((await run([from])).status).toBe("not_found");
      mkdirSync(join(from, "nested"));
      const flags = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["locate", opening, join(from, "nested")], {}, flags)).toBe(1);
      expect(await threadsCommand.run(["locate", opening, join(from, "missing")], {}, flags)).toBe(1);
      symlinkSync(to, join(from, "alias"));
      expect(await threadsCommand.run(["locate", opening, join(from, "alias")], {}, flags)).toBe(1);
      expect(await threadsCommand.run(["locate", "not-an-id", from], {}, flags)).toBe(1);
      const duplicate = join(from, "_threads", "copy");
      // A copied Thread carries the same opening id; never guess which copy the person meant.
      const { cpSync } = await import("node:fs"); cpSync(moved, duplicate, { recursive: true });
      expect((await run([from, to])).status).toBe("ambiguous");
      expect(threadFlagError("locate", { typo: true })).toContain("--typo");
    } finally { process.stdout.write = write; process.chdir(old); }
  });

  it("accepts a documented flag per verb before enforcing unknown-flag rejection", () => {
    for (const [verb, flag] of Object.entries({
      list: "depth", open: "post", read: "since", new: "about", post: "reply-to",
      posts: "limit", close: "message", render: "", init: "", push: "remote", send: "grade",
      reply: "send-id", expand: "", add: "grade", rename: "name",
    })) {
      expect(threadFlagError(verb, flag ? { [flag]: "value" } : {}), verb).toBeUndefined();
      expect(threadFlagError(verb, { typo: true }), verb).toContain("--typo");
    }
  });

  it("refuses unknown flags on every Thread verb before reading or writing", async () => {
    const write = process.stderr.write; let errors = "";
    process.stderr.write = ((chunk: string) => { errors += chunk; return true; }) as typeof process.stderr.write;
    try {
      const global = { json: false, quiet: true, yes: false, help: false };
      for (const verb of ["list", "open", "read", "new", "post", "posts", "close", "render", "init", "push", "send", "reply", "expand", "add", "rename"]) {
        errors = "";
        expect(await threadsCommand.run([verb, "somewhere"], { unknown: "value" }, global)).toBe(1);
        expect(errors).toContain(`Unknown flag for threads ${verb}: --unknown`);
      }
    } finally { process.stderr.write = write; }
  });

  it("reports a partial threads new when the opening post cannot be dated", async () => {
    const root = fixture(); process.env.HOME = root;
    const previous = process.cwd(); process.chdir(root);
    const stderrWrite = process.stderr.write; let err = "";
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NaN));
    try {
      const flags = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["new", "incomplete"], { about: "Incomplete" }, flags)).toBe(1);
      expect(err).toContain("Thread created at");
      expect(err).toContain("Use threads post incomplete");
      expect(loadThread(join(root, "_threads", "incomplete")).posts).toEqual([]);
    } finally { vi.useRealTimers(); process.stderr.write = stderrWrite; process.chdir(previous); }
  });

  it("opens local Threads by rung and bounds posts without leaking bodies", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("disclosure", "Disclosure", root);
    writeFileSync(join(thread.path, "README.md"), "---\nname: Disclosure\nsummary: A decision\n---\n\n# Disclosure\n\n## Current frame\n\nToday we decide.\n");
    writeFileSync(join(thread.path, "_agent/agreement.md"), "---\nname: Agreement — Disclosure\nsummary: A decision\n---\n\n# Agreement\n\n## Goal\n\nKeep it honest.\n\n## Done when\n\nOne reply is read.\n");
    const first = appendPost(thread.path, { body: "Private opening", author: "Agent A", name: "Opening" });
    const second = appendPost(thread.path, { body: "Private reply", author: "Agent B", name: "Reply", summary: "A bounded decision", replyTo: [first.post.id] });
    const previous = process.cwd(); process.chdir(root);
    const write = process.stdout.write; let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    const global = { json: true, quiet: true, yes: false, help: false };
    async function open(options: Record<string, string | boolean>) { out = ""; expect(await threadsCommand.run(["open", "disclosure"], options, global)).toBe(0); return JSON.parse(out); }
    try {
      const named = await open({ depth: "name" });
      expect(named.posts).toEqual([]);
      expect(named.thread.frame).toMatchObject({ current_frame: "Today we decide.", goal: "Keep it honest.", done_when: "One reply is read." });
      const allSummaries = await open({ depth: "summary" });
      expect(allSummaries.posts).toEqual([]);
      expect(out).not.toContain("Private opening");
      const summary = await open({ depth: "summary", since: first.post.id });
      expect(summary.posts).toMatchObject([{ id: second.post.id, in_reply_to: [first.post.id], author: "Agent B" }]);
      expect(out).not.toContain("Private reply");
      const children = await open({ depth: "children" });
      expect(children.posts).toEqual([]);
      expect(children.branches[0].tip_id).toBe(second.post.id);
      expect(out).not.toContain("Private reply");
      const surface = await open({ depth: "surface", post: second.post.id });
      expect(surface.posts).toHaveLength(1);
      expect(surface.raw_post).toContain("Private reply");
      expect(out).not.toContain("Private opening");
      expect(await threadsCommand.run(["open", "disclosure"], { post: second.post.id, since: first.post.id }, global)).toBe(1);
      expect(await threadsCommand.run(["open", "disclosure"], { depth: "name", ack: true }, global)).toBe(1);
    } finally { process.stdout.write = write; process.chdir(previous); }
  });

  it("preserves exact frame and summary fields in JSON while marking shortened human text", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("exact", "Exact", root);
    const frame = "F".repeat(1600);
    const summary = "S".repeat(600);
    writeFileSync(join(thread.path, "README.md"), `---\nname: Exact\nsummary: Frame test\n---\n## Current frame\n\n${frame}\n`);
    const post = appendPost(thread.path, { body: "Body", name: "Post", summary });
    const previous = process.cwd(); process.chdir(root);
    const original = process.stdout.write; let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      const json = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["open", "exact"], { depth: "name" }, json)).toBe(0);
      expect(JSON.parse(out).thread.frame.current_frame).toBe(frame);
      out = "";
      expect(await threadsCommand.run(["open", "exact"], { depth: "summary", limit: "1" }, json)).toBe(0);
      expect(JSON.parse(out).posts.find((p: { id: string }) => p.id === post.post.id).summary).toBe(summary);
      out = "";
      expect(await threadsCommand.run(["open", "exact"], { depth: "name" }, { ...json, json: false })).toBe(0);
      expect(out).toContain("[shortened; read this Thread's README.md for the full frame]");
    } finally { process.stdout.write = original; process.chdir(previous); }
  });

  it("threads read --json returns authored date and legacy filename fallback", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("legacy", "Legacy", root);
    writeFileSync(join(thread.path, "2026-09-26T10-00-00Z-old.md"), "---\nid: msg_old\n---\nOld\n");
    writeFileSync(join(thread.path, "2026-09-26T11-00-00Z-authored.md"),
      "---\nid: msg_new\ndate: 2026-09-26T12:00:00.000Z\n---\nNew\n");
    const previous = process.cwd(); process.chdir(root);
    const write = process.stdout.write; let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      const flags = { json: true, quiet: true, yes: false, help: false };
      expect(await threadsCommand.run(["read", "legacy"], { depth: "full" }, flags)).toBe(0);
      const posts = JSON.parse(out).posts;
      expect(posts.find((p: { id: string }) => p.id === "msg_old").date).toBe("2026-09-26T10:00:00.000Z");
      expect(posts.find((p: { id: string }) => p.id === "msg_new").date).toBe("2026-09-26T12:00:00.000Z");
      out = "";
      expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
      expect(JSON.parse(out).threads[0].latest_activity_at).toBe("2026-09-26T12:00:00.000Z");
    } finally { process.stdout.write = write; process.chdir(previous); }
  });

  it("orders date-only posts by filename, warns on malformed dates, and projects summary/render", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("legacy", "Legacy", root);
    createThread("empty", "Empty", root);
    writeFileSync(join(thread.path, "2026-09-27T09-20-00Z-day.md"), "---\nid: msg_day\ndate: 2026-09-27\n---\nDay\n");
    writeFileSync(join(thread.path, "2026-09-28T10-00-00Z-bad.md"), "---\nid: msg_bad\ndate: yesterday\n---\nBad date\n");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: false, yes: false, help: false };
    try {
      expect(await threadsCommand.run(["read", "legacy"], { depth: "summary", limit: "10", order: "older" }, flags)).toBe(0);
      const posts = JSON.parse(out).posts;
      expect(posts.find((p: { id: string }) => p.id === "msg_day").date).toBe("2026-09-27");
      expect(posts.find((p: { id: string }) => p.id === "msg_bad").date).toBeNull();
      expect(err).toContain("date: invalid_date");
      expect(JSON.parse(out).thread.warnings).toEqual(expect.arrayContaining([expect.stringContaining("date: invalid_date")]));
      err = ""; out = "";
      expect(await threadsCommand.run(["read", "legacy"], {}, { ...flags, quiet: true })).toBe(0);
      expect(err).toBe("");
      out = "";
      expect(await threadsCommand.run(["render", "legacy"], {}, flags)).toBe(0);
      expect(JSON.parse(out).timeline.find((p: { id: string }) => p.id === "msg_day").date).toBe("2026-09-27");
      out = "";
      expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
      const rows = JSON.parse(out).threads;
      expect(rows.find((r: { slug: string }) => r.slug === "legacy").latest_activity_at).toBe("2026-09-27T09:20:00.000Z");
      expect(rows.find((r: { slug: string }) => r.slug === "empty").latest_activity_at).toBeNull();
    } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; process.chdir(previous); }
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
      const teamPost = appendPost(t.path, { body: "Team", author: "Agent" });
      expect(await threadsCommand.run(["open", "decision"], { post: teamPost.post.id }, flags)).toBe(0);
      expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
      git(join(root, "_threads"), "add", "decision");
      git(join(root, "_threads"), "commit", "-m", "post");
      expect(await threadsCommand.run(["push"], {}, flags)).toBe(1);
      const bare = join(root, "team.git"); git(root, "init", "--bare", bare);
      git(root, "remote", "add", "team", bare);
      expect(await threadsCommand.run(["push"], { remote: "team" }, flags)).toBe(0);
      expect(git(root, "ls-remote", "team", "refs/heads/threads")).toContain("refs/heads/threads");
    } finally { process.stdout.write = old; process.chdir(previous); }
  });

  it("reports an unreadable sibling as incomplete without hiding healthy Threads", async () => {
    const root = fixture(); process.env.HOME = root;
    const healthy = createThread("healthy", "Healthy", root);
    const opening = appendPost(healthy.path, { body: "Good" });
    const bad = createThread("bad", "Bad", root);
    writeFileSync(join(bad.path, "invalid.md"), "---\nkind: post\n---\nNo id");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: false, yes: false, help: false };
    try {
      expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
      expect(JSON.parse(out).schema).toBe("ideaspaces.threads.list.v2");
      expect(JSON.parse(out).local_complete).toBe(false);
      expect(JSON.parse(out).threads).toHaveLength(2);
      expect(JSON.parse(out).threads.find((t: { slug: string }) => t.slug === "bad").closed).toBe("unknown");
      expect(JSON.parse(out).threads.find((t: { slug: string }) => t.slug === "bad").parent.status).toBe("unknown");
      expect(err).toContain("_threads/bad/invalid.md: frontmatter: invalid_id");
      out = ""; err = "";
      expect(await threadsCommand.run(["open", "healthy"], { post: opening.post.id }, flags)).toBe(0);
      expect(JSON.parse(out).child_threads_complete).toBe(false);
      expect(JSON.parse(out).child_threads_total).toBe(0); // known lower bound, not proof of no children
      expect(err).toContain("Thread bad parent unknown");
      // Plain Markdown is a valid Agreement with no declared legacy parent.
      writeFileSync(join(healthy.path, "_agent", "agreement.md"), "Plain Markdown Agreement without frontmatter\n");
      out = ""; err = "";
      expect(await threadsCommand.run(["open", "healthy"], { post: opening.post.id }, flags)).toBe(0);
      expect(JSON.parse(out).raw_post).toContain("Good");
      expect(JSON.parse(out).thread.parent).toBeNull();
      expect(JSON.parse(out).thread.parent_warning).toBeUndefined();
      expect(err).not.toContain("parent cannot be read");
      // Broken YAML, unlike plain Markdown, is an invalid Agreement frame.
      writeFileSync(join(healthy.path, "_agent", "agreement.md"), "---\nattached_to: [\n---\nBroken Agreement\n");
      out = ""; err = "";
      expect(await threadsCommand.run(["open", "healthy"], { post: opening.post.id }, flags)).toBe(0);
      expect(JSON.parse(out).thread.parent_warning).toContain("Malformed Thread Agreement");
    } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; process.chdir(previous); }
  });

  it("resolves a separate orphan worktree at the authored commit, not HEAD", async () => {
    const root = fixture(); process.env.HOME = root;
    writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\nroot_node_id: n_0123456789abcdef01234567\n---\n");
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
      expect(await threadsCommand.run(["open", t.path], { map, member: "0", depth: "full" }, flags)).toBe(0);
      expect(JSON.parse(output).pinned).toContain("At pin");
      output = "";
      expect(await threadsCommand.run(["open", "decision"], { pin, position: "_threads/decision/_agent/agreement.md" }, flags)).toBe(1);
      output = "";
      expect(await threadsCommand.run(["open", "decision"], { pin, position: `_threads/decision/${one.post.path}`, depth: "full" }, flags)).toBe(0);
      expect(JSON.parse(output).pinned).toContain("At pin");
      createThread("other", "Other", root);
      expect(await threadsCommand.run(["open", "other"], { map, member: "0", checkout: root }, flags)).toBe(1);
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

  it("default reply-to targets the opening post and warns on stderr; --reply-to latest targets newest tip", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: false, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean> = {}) => {
      out = ""; err = "";
      expect(await threadsCommand.run(args, options, flags)).toBe(0);
      return JSON.parse(out);
    };
    try {
      const opened = await run(["new", "tree-test"], { about: "Tree root" });
      const openingId = opened.opening_post_id;
      expect(openingId).toMatch(/^msg_/);

      // Post 1 without --reply-to: replies to opening post, prints notice on stderr
      const post1 = await run(["post", "tree-test"], { message: "First branch", name: "Branch 1" });
      expect(err).toContain(`Replying to opening post ${openingId}`);
      expect(post1.kind).toBe("post");

      // Post 2 without --reply-to: ALSO replies to opening post, prints notice on stderr (sibling of post 1, NOT chain)
      const post2 = await run(["post", "tree-test"], { message: "Second branch", name: "Branch 2" });
      expect(err).toContain(`Replying to opening post ${openingId}`);

      // Inspect posts
      const thread = loadThread(join(root, "_threads", "tree-test"));
      const p1 = thread.posts.find((p) => p.id === post1.id)!;
      const p2 = thread.posts.find((p) => p.id === post2.id)!;
      expect(p1.inReplyTo).toEqual([openingId]);
      expect(p2.inReplyTo).toEqual([openingId]);
      expect(post1.in_reply_to).toEqual([openingId]);
      expect(post2.in_reply_to).toEqual([openingId]);
      const branchRead = await run(["open", "tree-test"], { depth: "children" });
      expect(branchRead.branches.map((b: { root_id: string }) => b.root_id).sort()).toEqual([post1.id, post2.id].sort());

      // Post 3 with --reply-to latest: explicitly targets post 2 without stderr notice
      err = "";
      const post3 = await run(["post", "tree-test"], { message: "Reply to latest", "reply-to": "latest" });
      expect(err).toBe("");
      const p3 = loadThread(join(root, "_threads", "tree-test")).posts.find((p) => p.id === post3.id)!;
      expect(p3.inReplyTo).toEqual([post2.id]);
      const joinPost = await run(["post", "tree-test"], { message: "Join", "reply-to": `latest,${post1.id}` });
      expect(loadThread(join(root, "_threads", "tree-test")).posts.find((p) => p.id === joinPost.id)?.inReplyTo).toEqual([post3.id, post1.id]);
      const quiet = await threadsCommand.run(["post", "tree-test"], { message: "Quiet branch" }, { ...flags, quiet: true });
      expect(quiet).toBe(0);
      expect(err).toBe("");
      expect(await threadsCommand.run(["post", "tree-test"], { message: "invalid", "reply-to": "latest,missing" }, flags)).toBe(1);
    } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; process.chdir(previous); }
  });

  it("writes and reads --tags on posts and preserves them across open rungs", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean> = {}) => {
      out = ""; err = "";
      expect(await threadsCommand.run(args, options, flags)).toBe(0);
      return JSON.parse(out);
    };
    try {
      await run(["new", "tag-test"], { about: "Tag test" });
      const posted = await run(["post", "tag-test"], { message: "Friction felt", name: "A friction", tags: "friction, ux" });
      const raw = readFileSync(posted.path, "utf8");
      expect(raw).toContain("tags:");
      expect(raw).toContain("- friction");
      expect(raw).toContain("- ux");

      const openedSummary = await run(["open", "tag-test"], { depth: "summary", limit: "10" });
      const taggedPost = openedSummary.posts.find((p: { id: string }) => p.id === posted.id);
      expect(taggedPost.tags).toEqual(["friction", "ux"]);
      expect(await threadsCommand.run(["post", "tag-test"], { message: "Bad", tags: "a,,b" }, flags)).toBe(1);
      expect(err).toContain("--tags must contain non-empty");
    } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; process.chdir(previous); }
  });

  it("reads local Threads as a tree across five depths with limit and order", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean> = {}) => {
      out = ""; err = "";
      expect(await threadsCommand.run(args, options, flags)).toBe(0);
      return JSON.parse(out);
    };
    try {
      const parentThread = await run(["new", "parent-thread"], { about: "Parent discussion" });
      const pOpeningId = parentThread.opening_post_id;
      const pDecision = await run(["post", "parent-thread"], { message: "Parent milestone", name: "Milestone 1", summary: "Milestone summary", "reply-to": pOpeningId });

      // Child Thread attached by post path
      const childThread = await run(["new", "child-thread"], { about: "Child discussion" });
      writeFileSync(join(root, "_threads", "child-thread", "_agent", "agreement.md"),
        `---\nname: Agreement — Child\nsummary: Child summary\nattached_to: _threads/parent-thread/${pDecision.path.split("/").pop()}\n---\n# Child\n`);

      const cOpeningId = childThread.opening_post_id;
      const cSnapshot = await run(["post", "child-thread"], { message: "Snapshot state", name: "Snapshot 1", summary: "Snapshot summary", kind: "snapshot", "reply-to": cOpeningId });
      const cLater = await run(["post", "child-thread"], { message: "Subsequent work", name: "Later 1", "reply-to": cSnapshot.id });

      // 1. depth: name
      const nameRead = await run(["open", "child-thread"], { depth: "name" });
      expect(nameRead.posts).toEqual([]);
      expect(nameRead.thread.parent).toMatchObject({ id: pDecision.id, slug: "parent-thread" });

      // 2. depth: summary
      const summaryRead = await run(["open", "child-thread"], { depth: "summary" });
      expect(summaryRead.thread.parent).toMatchObject({ id: pDecision.id, slug: "parent-thread", name: "Milestone 1" });
      expect(summaryRead.thread.snapshot).toMatchObject({ id: cSnapshot.id, kind: "snapshot", name: "Snapshot 1" });

      // 3. depth: children (shows branches + child threads)
      const parentChildren = await run(["open", "parent-thread"], { depth: "children" });
      expect(parentChildren.child_threads).toHaveLength(1);
      expect(parentChildren.child_threads[0]).toMatchObject({ slug: "child-thread", attached_to_post_id: pDecision.id });
      expect(parentChildren.branches.length).toBeGreaterThanOrEqual(1);
      await run(["new", "sibling-child"], { about: "Sibling child" });
      writeFileSync(join(root, "_threads", "sibling-child", "_agent", "agreement.md"),
        `---\nname: Agreement — Sibling\nattached_to: _threads/parent-thread/${pDecision.path.split("/").pop()}\n---\n`);
      const boundedChildren = await run(["open", "parent-thread"], { depth: "children", limit: "1" });
      expect(boundedChildren.child_threads).toHaveLength(1);
      expect(boundedChildren.child_threads_total).toBe(2);
      expect(boundedChildren.branches_total).toBeGreaterThanOrEqual(1);

      // 4. depth: surface (shows snapshot and posts after it)
      const surfaceRead = await run(["open", "child-thread"], { depth: "surface" });
      expect(surfaceRead.posts).toHaveLength(2);
      expect(surfaceRead.posts[0].id).toBe(cSnapshot.id);
      expect(surfaceRead.posts[1].id).toBe(cLater.id);

      // 5. depth: full with --limit and --order
      const fullNewer = await run(["open", "child-thread"], { depth: "full", order: "newer", limit: "1" });
      expect(fullNewer.posts).toHaveLength(1);
      expect(fullNewer.posts[0].id).toBe(cLater.id);
      for (const bad of [{ limit: "0" }, { limit: "abc" }, { order: "sideways" }, { depth: "full", limit: "1", ack: true }]) {
        expect(await threadsCommand.run(["open", "child-thread"], bad, flags)).toBe(1);
      }
      expect(await threadsCommand.run(["open", "x_" + "a".repeat(24)], { limit: "1" }, flags)).toBe(1);
      expect(await threadsCommand.run(["read", "x_" + "a".repeat(24)], { order: "newer" }, flags)).toBe(1);
      expect(await threadsCommand.run(["open", "child-thread"], { depth: "name", limit: "1" }, flags)).toBe(1);
      expect(await threadsCommand.run(["open", "child-thread"], { post: cLater.id, order: "older" }, flags)).toBe(1);

      // 6. --post <id> lists child threads that grew from that post
      const postRead = await run(["open", "parent-thread"], { post: pDecision.id });
      expect(postRead.child_threads).toHaveLength(2);
      expect(postRead.child_threads_total).toBe(2);
      expect(postRead.child_threads.map((t: { slug: string }) => t.slug).sort()).toEqual(["child-thread", "sibling-child"]);

      // 7. threads list carries parent
      const listRead = await run(["list"], { depth: "name" });
      const childRow = listRead.threads.find((t: { slug: string }) => t.slug === "child-thread");
      expect(childRow.parent).toMatchObject({ id: pDecision.id, slug: "parent-thread" });
    } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; process.chdir(previous); }
  });

  it("surface previews a head and tail, full preserves exact bodies, and incomplete reads cannot ack", async () => {
    const root = fixture(); process.env.HOME = root;
    const thread = createThread("large", "Large", root);
    const opening = appendPost(thread.path, { body: "Opening" });
    const snapshot = appendPost(thread.path, { body: "Head", kind: "snapshot", replyTo: [opening.post.id] });
    const large = appendPost(thread.path, { body: "Z".repeat(1200), replyTo: [snapshot.post.id] });
    const last = appendPost(thread.path, { body: "Last", replyTo: [large.post.id] });
    const old = process.cwd(); process.chdir(root);
    const writer = process.stdout.write; let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    try {
      expect(await threadsCommand.run(["open", "large"], { depth: "surface", limit: "1" }, flags)).toBe(0);
      const surface = JSON.parse(out);
      expect(surface.posts.map((p: { id: string }) => p.id)).toEqual([snapshot.post.id]);
      expect(surface.matching).toBe(4); // includes opening post before the snapshot
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "surface", order: "newer", limit: "2" }, flags)).toBe(0);
      expect(JSON.parse(out).posts.map((p: { id: string }) => p.id)).toEqual([last.post.id, snapshot.post.id]);
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "surface", limit: "3" }, flags)).toBe(0);
      const preview = JSON.parse(out).posts.find((p: { id: string }) => p.id === large.post.id);
      expect(preview.body).toContain("body truncated; use --post");
      expect(preview.body_truncated).toBe(true);
      expect(await threadsCommand.run(["open", "large"], { depth: "full", since: snapshot.post.id, order: "newer" }, flags)).toBe(1);
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "full", limit: "10" }, flags)).toBe(0);
      expect(JSON.parse(out).posts.find((p: { id: string }) => p.id === large.post.id).body.trim()).toBe("Z".repeat(1200));
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "full", limit: "1" }, { ...flags, json: false })).toBe(0);
      expect(out).toContain("Showing 1 of 4 matching posts. Continue with --since");
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "surface", ack: true }, flags)).toBe(1);
      expect(readCursor(loadThread(thread.path)).size).toBe(0);
      out = "";
      expect(await threadsCommand.run(["open", "large"], { depth: "surface", new: true, ack: true, order: "older", limit: "10" }, flags)).toBe(1);
      expect(readCursor(loadThread(thread.path)).size).toBe(0);
    } finally { process.stdout.write = writer; process.chdir(old); }
  });

  it("keeps bad-Map and unknown-kind posts when the opening needs repair", () => {
    const root = fixture(); const t = createThread("fixture", "Fixture", root);
    const openingPath = join(t.path, "00-opening.md");
    writeFileSync(openingPath, "---\nid: [\n---\nBroken opening");
    writeFileSync(join(t.path, "01-map.md"), "---\nid: msg_map\nmap: [broken]\n---\nReadable map sibling");
    writeFileSync(join(t.path, "02-kind.md"), "---\nid: msg_future\nkind: x_future\n---\nReadable unknown kind");
    const blocked = loadThread(t.path);
    expect(blocked.thread_id).toBeNull();
    expect(blocked.closed).toBe("unknown");
    expect(blocked.attachment).toBe("unknown");
    expect(blocked.posts.map((post) => post.id)).toEqual(["msg_map", "msg_future"]);
    expect(blocked.warnings.join("\n")).toContain("_threads/fixture/01-map.md: map: invalid_map_type");
    expect(() => appendPost(t.path, { body: "Refused" })).toThrow(/Opening post .*00-opening\.md.*Any Thread writer may repair/);
    // Repair a never-valid post; a committed repair must explain why.
    writeFileSync(openingPath, "---\nid: msg_open\n---\nRepaired opening");
    const restored = loadThread(t.path);
    expect(restored.thread_id).toBe("msg_open");
    expect(restored.closed).toBe(false);
    writeFileSync(join(t.path, "03-unreadable.md"), "---\nid: [\nkind: closure\n---\nCannot parse closure");
    expect(loadThread(t.path).closed).toBe("unknown");
    expect(appendPost(t.path, { body: "Still writable", kind: "future_kind" }).post.kind).toBe("future_kind");
    appendPost(t.path, { body: "Closed", kind: "closure" });
    expect(loadThread(t.path).closed).toBe(true);
  });

  it("writes optional opening attachments and resolves only post links as child edges", async () => {
    const root = fixture(); process.env.HOME = root;
    const old = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean>) => {
      out = ""; err = "";
      expect(await threadsCommand.run(args, options, flags)).toBe(0);
      return JSON.parse(out);
    };
    try {
      const parent = await run(["new", "parent"], { about: "Parent" });
      const child = await run(["new", "child"], { about: "Child", "attached-to": `post:${parent.opening_post_id}` });
      expect(child.attached_to).toBe(`post:${parent.opening_post_id}`);
      expect(loadThread(join(root, "_threads", "child")).allPosts[0].attachedTo?.kind).toBe("post");
      const linked = await run(["new", "linked"], { about: "Linked", "attached-to": "note:@home//notes/topic.md" });
      expect(linked.attached_to).toBe("note:@home//notes/topic.md");
      writeFileSync(join(root, "_threads", "linked", "zz-bad.md"), "---\nid: msg_bad_map\nmap: [broken]\n---\nReadable sibling");
      const linkedOpen = await run(["open", "linked"], { depth: "name" });
      expect(linkedOpen.thread.parent.status).toBe("none");
      const rows = await run(["list"], { depth: "summary" });
      expect(rows.local_complete).toBe(true); // Field warning, but the post remains readable.
      expect(rows.threads.find((row: { slug: string }) => row.slug === "linked").parent.status).toBe("none");
      expect(linkedOpen.thread.warnings).toContain("_threads/linked/zz-bad.md: map: invalid_map_type");
      const parentPost = await run(["open", "parent"], { post: parent.opening_post_id });
      expect(parentPost.child_threads.map((row: { slug: string }) => row.slug)).toEqual(["child"]);
      out = ""; err = "";
      expect(await threadsCommand.run(["new", "bad"], { about: "Bad", "attached-to": "post:missing" }, flags)).toBe(1);
      expect(err).toContain("invalid attached_to field");
      expect(readdirSync(join(root, "_threads"))).not.toContain("bad");
      err = "";
      expect(await threadsCommand.run(["new", "no-type"], { about: "No type", "attached-to": "msg_parent" }, flags)).toBe(1);
      expect(err).toContain("<type>:<id>");
      expect(readdirSync(join(root, "_threads"))).not.toContain("no-type");
    } finally { process.chdir(old); process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; }
  });

  it("writes and folds mark posts; validates before writing or accepting literal escapes", async () => {
    const root = fixture(); process.env.HOME = root;
    const old = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "", err = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean>) => {
      out = ""; err = "";
      const code = await threadsCommand.run(args, options, flags);
      expect(code, err).toBe(0);
      return JSON.parse(out);
    };
    try {
      const t = await run(["new", "work"], { about: "Work" });
      const first = await run(["post", "work"], { kind: "mark", mark: "claimed", "reply-to": t.opening_post_id, message: "Claimed", author: "Integrator" });
      expect(first.mark).toBe("claimed");
      await run(["post", "work"], { kind: "mark", mark: "claimed", "reply-to": t.opening_post_id, message: "Repeat", author: "Integrator" });
      const before = await run(["open", "work"], { post: t.opening_post_id });
      expect(before.posts[0].marks).toHaveLength(1);
      expect(before.posts[0].marks[0]).toMatchObject({ mark: "claimed", author: "Integrator" });
      expect(before.thread.closed).toBe(false);
      expect((await run(["list"], { depth: "summary" })).threads.find((row: { slug: string }) => row.slug === "work").count).toBe(3); // Opening + 2 folded marks.
      out = "";
      expect(await threadsCommand.run(["open", "work"], { post: t.opening_post_id }, { ...flags, json: false })).toBe(0);
      expect(out).toContain("Marks: claimed (Integrator)");
      await run(["post", "work"], { kind: "correction", supersedes: first.id, "reply-to": t.opening_post_id, message: "Retract", author: "Integrator" });
      const after = await run(["open", "work"], { post: t.opening_post_id });
      expect(after.posts[0].marks).toHaveLength(1);
      expect(after.posts[0].marks[0].id).not.toBe(first.id);
      expect(loadThread(join(root, "_threads", "work")).allPosts.some((p) => p.id === first.id)).toBe(true);
      expect((await run(["open", "work"], { post: first.id })).posts[0]).toMatchObject({ id: first.id, kind: "mark", mark: "claimed" });
      out = ""; err = "";
      expect(await threadsCommand.run(["post", "work"], { kind: "snapshto", message: "Open kind", author: "Integrator" }, { ...flags, quiet: false })).toBe(0);
      expect(JSON.parse(out).kind).toBe("snapshto");
      expect(err).toContain("check spelling");
      const count = readdirSync(join(root, "_threads", "work")).length;
      out = ""; err = "";
      expect(await threadsCommand.run(["post", "work"], { kind: "mark", message: "No mark", "reply-to": t.opening_post_id, author: "Integrator" }, flags)).toBe(1);
      expect(err).toContain("--mark");
      out = ""; err = "";
      expect(await threadsCommand.run(["post", "work"], { mark: "done", message: "No kind", "reply-to": t.opening_post_id, author: "Integrator" }, flags)).toBe(1);
      expect(err).toContain("--mark requires --kind mark");
      out = ""; err = "";
      expect(await threadsCommand.run(["post", "work"], { kind: "mark", mark: "done", message: "No latest", "reply-to": "latest", author: "Integrator" }, flags)).toBe(1);
      expect(err).toContain("explicit target");
      out = ""; err = "";
      expect(await threadsCommand.run(["post", "work"], { message: "Bad Map", author: "Integrator", map: JSON.stringify({ roots: [], members: [{ root: 0, position: "_assets/nope.md" }] }) }, flags)).toBe(1);
      expect(err).toContain("map.members[0]");
      expect(() => appendPost(join(root, "_threads", "work"), { body: "First\\n\\nSecond", rejectEscapedNewlines: true })).toThrow(/literal/);
      expect(readdirSync(join(root, "_threads", "work"))).toHaveLength(count);
      // Stdin/programmatic bodies can intentionally describe literal escape syntax.
      expect(appendPost(join(root, "_threads", "work"), { body: "First\\n\\nSecond" }).post.body).toContain("\\n");
    } finally { process.chdir(old); process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; }
  });

  it("resolves a legacy msg_ parent and reverse child link", async () => {
    const root = fixture(); process.env.HOME = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Writer"); git(root, "config", "user.email", "writer@example.test");
    const previous = process.cwd(); process.chdir(root);
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const flags = { json: true, quiet: true, yes: false, help: false };
    const run = async (args: string[], options: Record<string, string | boolean> = {}) => {
      out = "";
      expect(await threadsCommand.run(args, options, flags)).toBe(0);
      return JSON.parse(out);
    };
    try {
      const mainThread = await run(["new", "main-room"], { about: "Main room" });
      const priorityPost = await run(["post", "main-room"], { message: "Priority 1 item", name: "Priority 1", "reply-to": mainThread.opening_post_id });

      // Legacy Agreement aliases remain readable; the opening post wins on new Threads.
      await run(["new", "sub-work"], { about: "Sub work" });
      writeFileSync(join(root, "_threads", "sub-work", "_agent", "agreement.md"),
        `---\nname: Agreement — Sub Work\nsummary: Sub work summary\nattached_to: ${priorityPost.id}\n---\n# Sub Work\n`);

      const openSub = await run(["open", "sub-work"], { depth: "name" });
      expect(openSub.thread.parent).toMatchObject({ attached_to: priorityPost.id, id: priorityPost.id, slug: "main-room" });

      const openPostInMain = await run(["open", "main-room"], { post: priorityPost.id });
      expect(openPostInMain.child_threads).toHaveLength(1);
      expect(openPostInMain.child_threads[0].slug).toBe("sub-work");
    } finally { process.stdout.write = stdoutWrite; process.chdir(previous); }
  });
});
