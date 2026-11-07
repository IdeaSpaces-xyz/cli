// Honest local Threads, E1 (d-pm's decision, 2026-11-07): a Thread reads in reply ancestry, parents first, never by date.
// The protocol's rule stays (ties by filename, then id); this locks the part that matters, so a reader that sorts by date fails here.
// Explorer measured 16 replies dated before their parent in one Space on 2026-11-05.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThread } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function inverted() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-thread-order-"))); temp.push(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  const dir = join(root, "_threads", "order");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "---\nname: Order\nsummary: Order.\n---\n# Order\n");
  const post = (file: string, id: string, date: string, parent?: string) =>
    writeFileSync(join(dir, file), `---\nid: ${id}\ndate: ${date}\nkind: post\nauthor: A${parent ? `\nin_reply_to: ${parent}` : ""}\n---\n\n${id}\n`);
  // The root is written last by the clock; its reply and the reply's reply carry earlier names and dates.
  post("2026-11-01T12-00-00-000Z-msg_a.md", "msg_a", "2026-11-01T12:00:00.000Z");
  post("2026-11-01T09-00-00-000Z-msg_b.md", "msg_b", "2026-11-01T09:00:00.000Z", "msg_a");
  post("2026-11-01T08-00-00-000Z-msg_c.md", "msg_c", "2026-11-01T08:00:00.000Z", "msg_b");
  // A sibling of the root's reply, dated between: it follows the root, and the date breaks the tie with msg_b only by filename.
  post("2026-11-01T10-00-00-000Z-msg_d.md", "msg_d", "2026-11-01T10:00:00.000Z", "msg_a");
  return { root, dir };
}

describe("a Thread reads in reply ancestry, never by date", () => {
  it("puts every parent before its replies even when the reply is named and dated earlier", () => {
    const { dir } = inverted();
    const ids = loadThread(dir).posts.map((post) => post.id);
    expect(ids[0]).toBe("msg_a");
    for (const [parent, reply] of [["msg_a", "msg_b"], ["msg_b", "msg_c"], ["msg_a", "msg_d"]]) expect(ids.indexOf(parent)).toBeLessThan(ids.indexOf(reply));
    // A date sort would have read c, b, d, a.
    expect(ids).not.toEqual(["msg_c", "msg_b", "msg_d", "msg_a"]);
  });

  it("is the order threads open pages in, newest page last: msg_c is the newest, though it is dated first", async () => {
    const { root } = inverted();
    const previous = process.cwd(); process.chdir(root);
    const old = process.stdout.write;
    let text = "";
    process.stdout.write = ((s: string) => { text += s; return true; }) as typeof process.stdout.write;
    try {
      expect(await threadsCommand.run(["open", "order"], { depth: "full" }, { json: true, quiet: true, yes: false, help: false })).toBe(0);
      const ids = JSON.parse(text).posts.map((post: { id: string }) => post.id);
      expect(ids[0]).toBe("msg_a");
      expect(ids.indexOf("msg_b")).toBeLessThan(ids.indexOf("msg_c"));
      text = "";
      expect(await threadsCommand.run(["open", "order"], { depth: "full", limit: "1", order: "newer" }, { json: true, quiet: true, yes: false, help: false })).toBe(0);
      expect(JSON.parse(text).posts.map((post: { id: string }) => post.id)).toEqual([ids.at(-1)]);
      expect(ids.at(-1)).not.toBe("msg_a");
    } finally { process.stdout.write = old; process.chdir(previous); }
  });
});
