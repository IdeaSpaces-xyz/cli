import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, loadThread, NO_THREAD_AGREEMENT, resolveThreadParent } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

// A Thread written by hand: no _agent/agreement.md of its own, and post ids
// with underscores. Reading and posting accept what they find; only a reply
// to an id that is not in the Thread is refused.
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const OPENING = "msg_fixture_opening_20261026";
const REPLY = "msg_fixture_wave1_20261026";

function handWrittenThread(): { root: string; thread: string } {
  const root = mkdtempSync(join(tmpdir(), "is-any-thread-")); temp.push(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Fixture Space\nsummary: Test\n---\n");
  const thread = join(root, "_threads", "hand-written");
  mkdirSync(thread, { recursive: true });
  writeFileSync(join(thread, "README.md"), "---\nname: Hand-written\nsummary: A Thread with no Agreement\n---\n\n# Hand-written\n");
  writeFileSync(join(thread, "2026-10-26T13-50-00-000Z-msg_fixture_opening.md"),
    `---\nid: ${OPENING}\ndate: 2026-10-26T13:50:00.000Z\nkind: post\nauthor: Fixture\nname: Opening\n---\n\nOpening body.\n`);
  writeFileSync(join(thread, "2026-10-26T14-30-00-000Z-msg_fixture_wave1.md"),
    `---\nid: ${REPLY}\ndate: 2026-10-26T14:30:00.000Z\nkind: post\nin_reply_to: ${OPENING}\nauthor: Fixture\nname: Wave 1\n---\n\nWave one body.\n`);
  return { root, thread };
}

async function run(args: string[], options: Record<string, string | boolean>, cwd: string): Promise<{ code: number; out: string; err: string }> {
  const previous = process.cwd(); process.chdir(cwd);
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  let out = ""; let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run(args, options, { json: true, quiet: true, yes: false, help: false });
    return { code, out, err };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous); }
}

describe("a Thread with no Agreement and underscore ids", () => {
  it("reads, with one note that it has no Agreement", async () => {
    const { root, thread } = handWrittenThread(); process.env.HOME = root;
    const loaded = loadThread(thread);
    expect(loaded.allPosts.map((post) => post.id)).toEqual([OPENING, REPLY]);
    expect(loaded.thread_id).toBe(OPENING);
    expect(loaded.warnings).toEqual([NO_THREAD_AGREEMENT]);
    expect(loaded.attachment).toBeNull();
    expect(resolveThreadParent(thread)).toBeNull();
    const opened = await run(["open", thread], { depth: "full" }, root);
    expect(opened.code).toBe(0);
    const json = JSON.parse(opened.out);
    expect(json.posts.map((post: { id: string }) => post.id)).toEqual([OPENING, REPLY]);
    expect(json.thread.warnings).toEqual([NO_THREAD_AGREEMENT]);
    const listed = await run(["list"], {}, root);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).threads.map((row: { slug: string }) => row.slug)).toEqual(["hand-written"]);
  });

  it("posts a reply to an underscore id through the command", async () => {
    const { root, thread } = handWrittenThread(); process.env.HOME = root;
    const posted = await run(["post", thread], { "reply-to": REPLY, author: "Tester", message: "A reply." }, root);
    expect(posted.err).toBe("");
    expect(posted.code).toBe(0);
    const id = JSON.parse(posted.out).id as string;
    const after = loadThread(thread);
    const reply = after.allPosts.find((post) => post.id === id)!;
    expect(reply.inReplyTo).toEqual([REPLY]);
    expect(reply.references).toEqual([REPLY]); // the hand-written parent carries no references of its own
    expect(readdirSync(thread).filter((name) => name.endsWith(".md"))).toHaveLength(4);
    expect(readdirSync(thread)).not.toContain("_agent"); // posting never invents an Agreement
  });

  it("still refuses a reply id that is not in the Thread, and writes nothing", async () => {
    const { root, thread } = handWrittenThread(); process.env.HOME = root;
    const before = readdirSync(thread).sort();
    const refused = await run(["post", thread], { "reply-to": "msg_fixture_missing_20261026", author: "Tester", message: "Lost." }, root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--reply-to must name distinct existing post ids in this Thread.");
    expect(readdirSync(thread).sort()).toEqual(before);
    expect(() => appendPost(thread, { body: "Lost", replyTo: ["msg_fixture_missing_20261026"] })).toThrow(/existing post ids/);
  });

  it("treats an empty _agent/ like no Agreement, and still refuses a symlinked one", () => {
    const { root, thread } = handWrittenThread(); process.env.HOME = root;
    mkdirSync(join(thread, "_agent"));
    expect(loadThread(thread).warnings).toEqual([NO_THREAD_AGREEMENT]);
    const outside = join(root, "outside.md");
    writeFileSync(outside, "---\nname: Elsewhere\n---\n");
    symlinkSync(outside, join(thread, "_agent", "agreement.md"));
    expect(() => loadThread(thread)).toThrow(/Refusing non-regular thread file/);
    rmSync(join(thread, "_agent", "agreement.md"));
    symlinkSync(join(root, "does-not-exist.md"), join(thread, "_agent", "agreement.md"));
    expect(() => loadThread(thread)).toThrow(/Refusing non-regular thread file/);
  });

  it("keeps a present Agreement's parent and reports no note", () => {
    const { root, thread } = handWrittenThread(); process.env.HOME = root;
    mkdirSync(join(thread, "_agent"));
    writeFileSync(join(thread, "_agent", "agreement.md"), "---\nname: Agreement — Hand-written\nsummary: Now it has one\n---\n");
    expect(loadThread(thread).warnings).toEqual([]);
    expect(readFileSync(join(thread, "_agent", "agreement.md"), "utf8")).toContain("Now it has one");
  });
});
