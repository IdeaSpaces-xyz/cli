import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";
import { listLocal, loadThread } from "../local/threads.js";

// A Thread's own _assets/ folder holds the files its posts link to. Every fixture is shaped as the
// refusals this fixes ("Unexpected thread entry: _assets"): a screenshot put in the Thread's
// _assets/, committed, then a post and a read of that Thread.

const ROOT_ID = "n_0123456789abcdef01234567";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of temp.splice(0)) {
    try { chmodSync(join(dir, "_threads", "bugs", "_assets"), 0o755); } catch { /* not every fixture locks it */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

function space(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "is-thread-assets-"))); temp.push(dir);
  process.env.HOME = dir;
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: Fixture\nsummary: Test\nroot_node_id: ${ROOT_ID}\n---\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test");
  git(dir, "add", "_agent/agreement.md"); git(dir, "commit", "-q", "-m", "init");
  return dir;
}

type Run = (args: string[], options: Record<string, string | boolean>) => Promise<{ code: number; json: any; err: string }>;
async function inSpace<T>(dir: string, fn: (run: Run) => Promise<T>): Promise<T> {
  const before = process.cwd(); process.chdir(dir);
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  const flags = { json: true, quiet: true, yes: false, help: false };
  try {
    return await fn(async (args, options) => {
      out = ""; err = "";
      const code = await threadsCommand.run(args, options, flags);
      return { code, json: code === 0 && out ? JSON.parse(out) : undefined, err: err + (code === 0 ? "" : out) };
    });
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(before); }
}

/** A Thread with an opening post, its Agreement, and a screenshot committed in its own _assets/. */
async function roomWithScreenshot(run: Run, dir: string, slug: string, shot: string) {
  const opened = await run(["new", slug], { about: "Bugs" });
  expect(opened.code, opened.err).toBe(0);
  const assets = join(dir, "_threads", slug, "_assets");
  mkdirSync(assets);
  writeFileSync(join(assets, shot), PNG);
  git(dir, "add", `_threads/${slug}/_assets/${shot}`); git(dir, "commit", "-q", "-m", "A screenshot for the friction");
  return { opening: opened.json.opening_post_id as string, assets };
}

describe("a Thread's own _assets/ folder", () => {
  it("posts a decision with the screenshot it was made from beside it, and reads the Thread", async () => {
    const dir = space();
    const shot = "2026-11-09-preview-as-it-was-seen.png";
    await inSpace(dir, async (run) => {
      const { opening } = await roomWithScreenshot(run, dir, "manual", shot);
      const posted = await run(["post", "manual"], {
        message: `The preview was chosen.\n\n![The preview, as it was seen](_assets/${shot})\n`,
        author: "Ana", "reply-to": opening,
      });
      expect(posted.code, posted.err).toBe(0);
      expect(posted.err).not.toMatch(/Unexpected thread entry/);
      const read = await run(["open", "manual"], { depth: "full" });
      expect(read.code, read.err).toBe(0);
      expect(read.json.posts).toHaveLength(2);
      expect(read.json.posts[1].body).toContain(`](_assets/${shot})`);
      expect(read.json.thread.unreadable_posts ?? []).toEqual([]);
    });
  });

  it("a Thread with a committed screenshot stays open to every post, read and listing", async () => {
    const dir = space();
    const shot = "2026-11-26-paste-in-the-thread-box.png";
    await inSpace(dir, async (run) => {
      const { opening } = await roomWithScreenshot(run, dir, "bugs", shot);
      // A Note in notes/ beside it: both folders together.
      mkdirSync(join(dir, "_threads", "bugs", "notes"));
      writeFileSync(join(dir, "_threads", "bugs", "notes", "idea.md"), "---\nname: Idea\nsummary: A Note\n---\nBody\n");
      for (const n of [1, 2]) {
        const posted = await run(["post", "bugs"], { message: `Friction ${n}: see ![shot](_assets/${shot})`, author: "Ana", "reply-to": opening });
        expect(posted.code, posted.err).toBe(0);
      }
      const rows = await run(["list"], { depth: "summary" });
      expect(rows.code, rows.err).toBe(0);
      expect(rows.json.local_complete).toBe(true);
      expect(listLocal(dir).find((t) => t.slug === "bugs")?.allPosts).toHaveLength(3);
      // The CLI commits the post alone: the screenshot's commit is the writer's, and nothing under _assets/ is touched.
      expect(git(dir, "status", "--porcelain", "--", "_threads/bugs/_assets")).toBe("");
      expect(readFileSync(join(dir, "_threads", "bugs", "_assets", shot))).toEqual(PNG);
    });
  });

  it("reads a post's picture from the Thread's _assets/, and still refuses a picture that is not there", async () => {
    const dir = space();
    await inSpace(dir, async (run) => {
      const { opening } = await roomWithScreenshot(run, dir, "bugs", "here.png");
      const missing = await run(["post", "bugs"], { message: "![gone](_assets/missing.png)", author: "Ana", "reply-to": opening });
      expect(missing.code).toBe(1);
      expect(missing.err).toMatch(/_assets\/missing\.png: no file at/);
      expect(missing.err).not.toMatch(/Unexpected thread entry/);
      const found = await run(["post", "bugs"], { message: "![here](_assets/here.png)", author: "Ana", "reply-to": opening });
      expect(found.code, found.err).toBe(0);
    });
  });

  it("never reads a Markdown file under _assets/ as a post, and never opens the folder to read the Thread", async () => {
    const dir = space();
    await inSpace(dir, async (run) => {
      const { assets } = await roomWithScreenshot(run, dir, "bugs", "shot.png");
      writeFileSync(join(assets, "looks-like-a-post.md"), "---\nid: msg_planted\nauthor: Someone\n---\nNot a post.\n");
      writeFileSync(join(assets, "broken.md"), "no frontmatter at all");
      const thread = loadThread(join(dir, "_threads", "bugs"));
      expect(thread.allPosts.map((post) => post.id)).not.toContain("msg_planted");
      expect(thread.allPosts).toHaveLength(1);
      expect(thread.unreadablePosts).toEqual([]);
      // A folder nobody may list is never listed: the Thread reads without opening it.
      chmodSync(assets, 0o000);
      expect(loadThread(join(dir, "_threads", "bugs")).allPosts).toHaveLength(1);
    });
  });

  it("allows _assets/ only as a real folder with that exact name; every other entry is refused as before", async () => {
    const dir = space();
    await inSpace(dir, async (run) => {
      expect((await run(["new", "bugs"], { about: "Bugs" })).code).toBe(0);
      const thread = join(dir, "_threads", "bugs");
      const elsewhere = join(dir, "elsewhere"); mkdirSync(elsewhere);
      const refused: Array<[string, () => void]> = [
        ["_assets", () => symlinkSync(elsewhere, join(thread, "_assets"), process.platform === "win32" ? "junction" : "dir")], // a link to a folder is not the folder
        ["_assets", () => writeFileSync(join(thread, "_assets"), "a file, not a folder")],
        ["_Assets", () => mkdirSync(join(thread, "_Assets"))], // exact and case-sensitive, as schema/assets.md says
        ["assets", () => mkdirSync(join(thread, "assets"))],
        ["files", () => mkdirSync(join(thread, "files"))],
        ["_scratch", () => mkdirSync(join(thread, "_scratch"))],
      ];
      for (const [name, make] of refused) {
        make();
        expect.soft(() => loadThread(thread), name).toThrow(`Unexpected thread entry: ${name} in ${thread}.`);
        // The refusal says what a Thread folder may hold and where a linked file goes instead.
        expect.soft(() => loadThread(thread), name).toThrow(/README\.md, _agent\/, notes\/ and _assets\/.*Move .* out of the Thread; a file a post links to goes in its _assets\//);
        rmSync(join(thread, name), { recursive: true, force: true });
      }
      mkdirSync(join(thread, "_assets"));
      expect(loadThread(thread).allPosts).toHaveLength(1);
    });
  });
});
