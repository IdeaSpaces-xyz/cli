import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";
import { loadThread } from "../local/threads.js";

const ROOT_ID = "n_0123456789abcdef01234567";
const OTHER_ID = "n_89abcdef0123456789abcdef";
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

/** A Space in its own repository, with a root identity and one commit. */
function space(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-from-note-"))); temp.push(dir);
  process.env.HOME = dir;
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: Fixture\nsummary: Test\nroot_node_id: ${ROOT_ID}\n---\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test");
  git(dir, "add", "_agent/agreement.md"); git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function note(dir: string, position: string, frontmatter: string, body = "The idea, in the person's words.\n") {
  mkdirSync(join(dir, position, ".."), { recursive: true });
  writeFileSync(join(dir, position), `---\n${frontmatter}\n---\n\n${body}`);
}

async function inSpace<T>(dir: string, fn: (run: (args: string[], options: Record<string, string | boolean>) => Promise<{ code: number; json: any; err: string }>) => Promise<T>): Promise<T> {
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
      return { code, json: code === 0 && out ? JSON.parse(out) : undefined, err };
    });
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(before); }
}

describe("threads new --from-note", () => {
  it("commits the Note alone, opens the Thread about it under the post, with the Note first in full", async () => {
    const dir = space();
    note(dir, "Ideas/garden.md", "name: Community garden\nsummary: Who plants what, and where");
    writeFileSync(join(dir, "other.md"), "staged by someone else\n");
    git(dir, "add", "other.md");
    await inSpace(dir, async (run) => {
      const parent = await run(["new", "parent"], { about: "Parent" });
      expect(parent.code).toBe(0);
      const made = await run(["new", "garden"], { "from-note": "Ideas/garden.md", "attached-to": `post:${parent.json.opening_post_id}` });
      expect(made.code, made.err).toBe(0);
      const head = git(dir, "rev-parse", "HEAD");
      expect(made.json.note).toEqual({ path: join(dir, "Ideas/garden.md"), position: "Ideas/garden.md", commit: head, committed: true, about: `note:@${ROOT_ID}//Ideas/garden.md` });
      expect(made.json.map).toEqual({ roots: 1, members: 1, defaulted_depths: 0 });
      expect(made.json.parent).toBe(`post:${parent.json.opening_post_id}`);
      expect(made.json.about).toEqual([`note:@${ROOT_ID}//Ideas/garden.md`]);
      // Only the Note went into that commit; the other session's staged file is still staged.
      expect(git(dir, "show", "--name-only", "--format=", head)).toBe("Ideas/garden.md");
      expect(git(dir, "diff", "--cached", "--name-only")).toBe("other.md");

      const thread = loadThread(join(dir, "_threads", "garden"));
      const opening = thread.allPosts[0]!;
      expect(thread.name).toBe("Community garden");
      expect(opening.frontmatter.summary).toBe("Who plants what, and where");
      expect(opening.frontmatter.map).toEqual({
        roots: [{ root_node_id: ROOT_ID, sha: head }],
        members: [{ root: 0, position: "Ideas/garden.md", depth: "full", name: "Community garden", summary: "Who plants what, and where" }],
      });
      expect(opening.frontmatter.parent).toBe(`post:${parent.json.opening_post_id}`);
      expect(opening.frontmatter.about).toEqual([`note:@${ROOT_ID}//Ideas/garden.md`]);
      expect(readFileSync(join(dir, "_threads", "garden", `${opening.path.split("/").pop()}`), "utf8")).toContain("From the Note [Community garden](../../Ideas/garden.md).");
    });
  });

  it("pins the Note's own Map: its own root with the Note, others from their checkout, and summary where it named no depth", async () => {
    const dir = space();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "is-from-note-other-"))); temp.push(other);
    mkdirSync(join(other, "_agent"));
    writeFileSync(join(other, "_agent", "agreement.md"), `---\nname: Other\nsummary: Other\nroot_node_id: ${OTHER_ID}\n---\n`);
    git(other, "init", "-q", "-b", "main"); git(other, "config", "user.name", "T"); git(other, "config", "user.email", "t@example.test");
    git(other, "add", "."); git(other, "commit", "-q", "-m", "init");
    const otherHead = git(other, "rev-parse", "HEAD");
    mkdirSync(join(dir, ".ideaspaces"), { recursive: true });
    writeFileSync(join(dir, ".ideaspaces", "map-checkouts.json"), JSON.stringify({ [other]: OTHER_ID }));
    writeFileSync(join(dir, "plot.md"), "---\nname: Plot\nsummary: The survey\n---\n");
    git(dir, "add", "plot.md"); git(dir, "commit", "-q", "-m", "plot");
    note(dir, "Ideas/plots.md", [
      "name: Plots", "summary: The plots idea", "map:", "  roots:", `    - root_node_id: ${ROOT_ID}`, `    - root_node_id: ${OTHER_ID}`,
      "  members:", "    - root: 0", "      position: plot.md", "    - root: 1", "      position: _agent/agreement.md", "      depth: surface",
      "    - root: 0", "      position: Ideas/plots.md", "      depth: surface", "    - address: https://example.org/plots",
    ].join("\n"));
    await inSpace(dir, async (run) => {
      const made = await run(["new", "plots"], { "from-note": join(dir, "Ideas/plots.md") });
      expect(made.code, made.err).toBe(0);
      const head = git(dir, "rev-parse", "HEAD");
      expect(made.json.map).toEqual({ roots: 2, members: 4, defaulted_depths: 1 });
      const map = loadThread(join(dir, "_threads", "plots")).allPosts[0]!.frontmatter.map as { roots: unknown[]; members: Array<Record<string, unknown>> };
      expect(map.roots).toEqual([{ root_node_id: ROOT_ID, sha: head }, { root_node_id: OTHER_ID, sha: otherHead }]);
      // The Note is read first, at the depth its author chose; the member with none reads at summary.
      expect(map.members.map((m) => [m.position ?? m.address, m.depth])).toEqual([
        ["Ideas/plots.md", "surface"], ["plot.md", "summary"], ["_agent/agreement.md", "surface"], ["https://example.org/plots", undefined],
      ]);
    });
  });

  it("takes a Note from a Thread's notes/ folder, and the Thread still reads its posts", async () => {
    const dir = space();
    await inSpace(dir, async (run) => {
      const parent = await run(["new", "parent"], { about: "Parent" });
      note(dir, "_threads/parent/notes/ask.md", "name: Ask around\nsummary: Who to ask first");
      const made = await run(["new", "ask"], { "from-note": "_threads/parent/notes/ask.md", "attached-to": `post:${parent.json.opening_post_id}` });
      expect(made.code, made.err).toBe(0);
      expect(made.json.note.position).toBe("_threads/parent/notes/ask.md");
      const opened = await run(["open", "parent"], { depth: "full" });
      expect(opened.code, opened.err).toBe(0);
      expect(opened.json.posts).toHaveLength(1);
      expect(opened.json.thread.unreadable_posts ?? []).toEqual([]);
      const rows = await run(["list"], { depth: "summary" });
      expect(rows.json.local_complete).toBe(true);
      expect(loadThread(join(dir, "_threads", "parent")).allPosts).toHaveLength(1);
    });
  });

  it("uses a Note already committed as it is, and --about names the Thread over the Note's name", async () => {
    const dir = space();
    note(dir, "Ideas/clean.md", "name: Clean\nsummary: Already in Git");
    git(dir, "add", "Ideas/clean.md"); git(dir, "commit", "-q", "-m", "clean");
    const head = git(dir, "rev-parse", "HEAD");
    await inSpace(dir, async (run) => {
      const made = await run(["new", "clean"], { "from-note": "Ideas/clean.md", about: "A better name" });
      expect(made.code, made.err).toBe(0);
      expect(made.json.note.committed).toBe(false);
      expect(made.json.note.commit).toBe(head);
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(loadThread(join(dir, "_threads", "clean")).name).toBe("A better name");
    });
  });

  it("refuses before any write: a misplaced Note, a bad Map, an unpinnable root, a taken slug, --map beside it", async () => {
    const dir = space();
    const head = git(dir, "rev-parse", "HEAD");
    await inSpace(dir, async (run) => {
      const parent = await run(["new", "parent"], { about: "Parent" });
      const posts = readdirSync(join(dir, "_threads", "parent")).sort();
      note(dir, "_agent/idea.md", "name: In the Agreement folder");
      note(dir, "Ideas/bad-map.md", "name: Bad\nmap: [broken]");
      note(dir, "Ideas/unpinned.md", `name: Unpinned\nmap:\n  roots:\n    - root_node_id: ${OTHER_ID}\n  members: []`);
      note(dir, "Ideas/fine.md", "name: Fine");
      note(dir, "Ideas/nameless.md", "summary: No name");
      const cases: Array<[string[], Record<string, string | boolean>, RegExp]> = [
        [["new", "a"], { "from-note": "_agent/idea.md" }, /_agent\/ folder/],
        [["new", "b"], { "from-note": "Ideas/bad-map.md" }, /Note's Map can't be read/],
        [["new", "c"], { "from-note": "Ideas/unpinned.md" }, /no pin and no checkout/],
        [["new", "parent"], { "from-note": "Ideas/fine.md" }, /already here/],
        [["new", "d"], { "from-note": "Ideas/fine.md", map: "x.map.md" }, /omit --map/],
        [["new", "e"], { "from-note": "Ideas/missing.md" }, /isn't there/],
        [["new", "f"], { "from-note": "Ideas/nameless.md" }, /--about/],
        [["new", "Bad_Slug"], { "from-note": "Ideas/fine.md" }, /slug/],
        [["new", "g"], { "from-note": true }, /requires the path/],
      ];
      for (const [args, options, message] of cases) {
        const result = await run(args, options);
        expect(result.code, `${args[1]}`).toBe(1);
        expect(result.err).toMatch(message);
      }
      expect(readdirSync(join(dir, "_threads")).sort()).toEqual(["parent"]);
      expect(readdirSync(join(dir, "_threads", "parent")).sort()).toEqual(posts);
      expect(git(dir, "log", "--format=%H")).toBe(head); // no Note was committed by a refusal
      void parent;
    });
  });

  it("puts the index back when the commit fails, and leaves the Note as written", async () => {
    const dir = space();
    note(dir, "Ideas/tracked.md", "name: Tracked");
    git(dir, "add", "Ideas/tracked.md"); git(dir, "commit", "-q", "-m", "tracked");
    note(dir, "Ideas/tracked.md", "name: Tracked", "Edited, not yet committed.\n");
    git(dir, "config", "--unset", "user.name"); git(dir, "config", "--unset", "user.email");
    git(dir, "config", "user.useConfigOnly", "true");
    await inSpace(dir, async (run) => {
      const result = await run(["new", "tracked"], { "from-note": "Ideas/tracked.md" });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/couldn't be committed.*on disk as you wrote it/);
    });
    expect(readFileSync(join(dir, "Ideas/tracked.md"), "utf8")).toContain("Edited, not yet committed.");
    expect(git(dir, "ls-files", "Ideas/tracked.md")).toBe("Ideas/tracked.md");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(join(dir, "_threads", "tracked"))).toBe(false);
  });
});
