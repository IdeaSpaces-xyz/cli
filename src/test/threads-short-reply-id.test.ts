import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, loadThread } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

// Agents meet a post's id in its eight-hex short form (`msg_1b7f2056`), the form post lines and
// summaries show. 80 --reply-to refusals in 38 sessions came mostly from passing that form on, or
// padding it to look whole (v20 Thread, AX's evidence msg_12eee1b5).
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const OPENING = "msg_1b7f2056-1111-4111-8111-111111111111";
const TWIN_A = "msg_7ff04a59-2222-4222-8222-222222222222";
const TWIN_B = "msg_7ff04a59-3333-4333-8333-333333333333";

function thread(): { root: string; thread: string } {
  const root = mkdtempSync(join(tmpdir(), "is-short-reply-")); temp.push(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Fixture Space\nsummary: Test\n---\n");
  const dir = join(root, "_threads", "short-ids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "---\nname: Short ids\nsummary: Replies by short id\n---\n\n# Short ids\n");
  const post = (stamp: string, id: string, name: string, parent?: string) => writeFileSync(join(dir, `${stamp}-${name.toLowerCase()}.md`),
    `---\nid: ${id}\ndate: 2026-11-12T0${stamp.slice(-1)}:00:00.000Z\nkind: post\n${parent ? `in_reply_to: ${parent}\n` : ""}author: Fixture\nname: ${name}\n---\n\n${name} body.\n`);
  post("2026-11-12T01-00-00-000Z-1", OPENING, "Opening");
  post("2026-11-12T02-00-00-000Z-2", TWIN_A, "TwinA", OPENING);
  post("2026-11-12T03-00-00-000Z-3", TWIN_B, "TwinB", OPENING);
  return { root, thread: dir };
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

describe("threads post --reply-to with a short id", () => {
  it("replies to the one post an eight-hex short id names, and records its full id", async () => {
    const { root, thread: dir } = thread(); process.env.HOME = root;
    const posted = await run(["post", dir], { "reply-to": "msg_1b7f2056", author: "Tester", message: "A reply." }, root);
    expect(posted.err).toBe("");
    expect(posted.code).toBe(0);
    const reply = loadThread(dir).allPosts.find((post) => post.id === JSON.parse(posted.out).id)!;
    expect(reply.inReplyTo).toEqual([OPENING]);
    // Two parents, one short and one full.
    const joined = appendPost(dir, { body: "Joins two.", replyTo: ["msg_1b7f2056", TWIN_A] });
    expect(joined.post.inReplyTo).toEqual([OPENING, TWIN_A]);
  });

  it("refuses a short id two posts share, naming both, and writes nothing", async () => {
    const { root, thread: dir } = thread(); process.env.HOME = root;
    const before = readdirSync(dir).sort();
    const refused = await run(["post", dir], { "reply-to": "msg_7ff04a59", author: "Tester", message: "Which one?" }, root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--reply-to msg_7ff04a59 matches 2 posts in this Thread");
    expect(refused.err).toContain(TWIN_A);
    expect(refused.err).toContain(TWIN_B);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("still refuses a padded or made-up id, and says which forms work", async () => {
    const { root, thread: dir } = thread(); process.env.HOME = root;
    for (const id of ["msg_1b7f2056-0000-0000-0000-000000000000", "msg_1b7f2056-placeholder", "msg_1b7f", "msg_deadbeef"]) {
      expect(() => appendPost(dir, { body: "Lost", replyTo: [id] }), id).toThrow(/existing post ids in this Thread\. Give a post's full msg_ id, or its eight-hex short form/);
    }
    // The same post twice, once short and once full, is not two parents.
    expect(() => appendPost(dir, { body: "Twice", replyTo: ["msg_1b7f2056", OPENING] })).toThrow(/distinct existing post ids/);
  });
});
