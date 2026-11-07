import { GIT_INTEGRATION_TIMEOUT } from "./git-integration-timeout.js";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPost, createThread } from "../local/threads.js";
import { checkThreads } from "../local/thread-check.js";
import { threadsCommand } from "../commands/threads.js";

const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" }).trim();
const files = (path: string) => readdirSync(path).filter((f) => f.endsWith(".md") && f !== "README.md").sort();

/** A Git Space with two Threads of two posts each, all committed. */
function space() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-thread-check-"))); temp.push(dir);
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  process.env.HOME = dir;
  git(dir, "init", "-q", "-b", "main");
  const make = (slug: string) => {
    const t = createThread(slug, `Thread ${slug}`, dir);
    appendPost(t.path, { body: "Opening", author: "Scout" });
    appendPost(t.path, { body: "Second", author: "Scout", replyTo: ["latest"] });
    return t;
  };
  const a = make("alpha"), b = make("beta");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "Threads");
  return { dir, a, b, threads: join(dir, "_threads") };
}

// The real-Git fixture took 5.275s on Windows; adjacent cases took 4.5–4.6s.
describe("threads check", { timeout: GIT_INTEGRATION_TIMEOUT }, () => {
  it("is clean when every post is as first committed, and READMEs and a new post do not count", () => {
    const { dir, a, threads } = space();
    appendFileSync(join(a.path, "README.md"), "\nCurated.\n");
    git(dir, "commit", "-qam", "README is curated");
    appendPost(a.path, { body: "Third", author: "Scout", replyTo: ["latest"] });
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "A new post is an addition");
    expect(checkThreads(threads)).toEqual({ checked: true, modified: [] });
  });

  it("names a post edited after its commit, with the commit, and one deleted, scoped to a Thread on request", () => {
    const { dir, a, b, threads } = space();
    const edited = files(a.path)[0], removed = files(b.path)[1];
    appendFileSync(join(a.path, edited), "\nAn edit.\n");
    git(dir, "commit", "-qam", "Fix: author corrected");
    rmSync(join(b.path, removed));
    git(dir, "commit", "-qam", "Remove a post");
    const all = checkThreads(threads);
    expect(all.checked).toBe(true);
    expect(all.modified.map((m) => `${m.thread}/${m.file}`)).toEqual([`alpha/${edited}`, `beta/${removed}`]);
    expect(all.modified[0].changes).toMatchObject([{ kind: "edited", subject: "Fix: author corrected", author: "T", commit: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    expect(all.modified[1].changes[0].kind).toBe("deleted");
    expect(checkThreads(threads, "alpha").modified.map((m) => m.thread)).toEqual(["alpha"]);
  });

  it("flags an edit or a delete that is not committed yet", () => {
    const { a, b, threads } = space();
    appendFileSync(join(a.path, files(a.path)[1]), "\nLate edit.\n");
    rmSync(join(b.path, files(b.path)[0]));
    const result = checkThreads(threads);
    expect(result.modified.map((m) => m.changes.map((c) => c.kind))).toEqual([["uncommitted-edit"], ["uncommitted-delete"]]);
  });

  it("says it could not check, and claims nothing clean, outside a Git repository", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "is-thread-check-nogit-"))); temp.push(dir);
    mkdirSync(join(dir, "_threads"));
    const result = checkThreads(join(dir, "_threads"));
    expect(result.checked).toBe(false);
    expect(result.note).toMatch(/not in a Git repository/);
  });

  it("reports through the command: JSON, text, and an exit code only under --strict", async () => {
    const { dir, a } = space();
    const previous = process.cwd(); process.chdir(dir);
    const old = process.stdout.write;
    let text = "";
    process.stdout.write = ((s: string) => { text += s; return true; }) as typeof process.stdout.write;
    const json = { json: true, quiet: true, yes: false, help: false };
    const run = async (options: Record<string, string | boolean>, expected: number, args: string[] = [], global = json) => { text = ""; expect(await threadsCommand.run(["check", ...args], options, global)).toBe(expected); return text; };
    try {
      expect(JSON.parse(await run({ strict: true }, 0))).toMatchObject({ schema: "ideaspaces.threads.check.v1", checked: true, clean: true, modified: [] });
      appendFileSync(join(a.path, files(a.path)[0]), "\nEdited.\n");
      git(dir, "commit", "-qam", "Edit a post");
      expect(JSON.parse(await run({}, 0))).toMatchObject({ clean: false, modified: [{ thread: "alpha", changes: [{ kind: "edited", subject: "Edit a post" }] }] });
      await run({ strict: true }, 1);
      await run({ strict: true }, 0, ["beta"]);
      const human = await run({}, 0, [], { ...json, json: false, quiet: false });
      expect(human).toContain("This Space: 1 post file was changed after it was first committed. Posts are immutable; a correction is a new post.");
      expect(human).toContain("edited in ");
    } finally { process.stdout.write = old; process.chdir(previous); }
  });
});

describe("threads check does not report wrongly", { timeout: GIT_INTEGRATION_TIMEOUT }, () => {
  it("does not call a post edited or deleted after commit when it was never committed: staged then edited, staged then deleted", () => {
    const { dir, a, threads } = space();
    const fresh = appendPost(a.path, { body: "Fresh", author: "Scout", replyTo: ["latest"] });
    const gone = appendPost(a.path, { body: "Gone", author: "Scout", replyTo: ["latest"] });
    git(dir, "add", "-A");
    appendFileSync(fresh.path, "\nEdited after staging.\n"); // AM
    rmSync(gone.path); // AD
    expect(git(dir, "status", "--porcelain", "--", "_threads/alpha")).toMatch(/^AM /m);
    expect(git(dir, "status", "--porcelain", "--", "_threads/alpha")).toMatch(/^AD /m);
    expect(checkThreads(threads)).toEqual({ checked: true, modified: [] });
  });

  it("does not say clean from a shallow clone, whose history stops at its depth, and still names what it can see", () => {
    const { dir, a } = space();
    const edited = files(a.path)[0];
    appendFileSync(join(a.path, edited), "\nAn edit, then more history on top.\n");
    git(dir, "commit", "-qam", "Edit a post");
    appendPost(a.path, { body: "Later", author: "Scout", replyTo: ["latest"] });
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "Later post");
    const clone = realpathSync(mkdtempSync(join(tmpdir(), "is-thread-check-shallow-"))); temp.push(clone);
    git(clone, "clone", "-q", "--depth", "1", `file://${dir}`, "c");
    const shallow = checkThreads(join(clone, "c", "_threads"));
    expect(shallow.checked).toBe(false);
    expect(shallow.note).toMatch(/shallow/);
    expect(shallow.note).toMatch(/git fetch --unshallow/);
    // The full clone sees the edit the shallow one cannot.
    git(join(clone, "c"), "fetch", "-q", "--unshallow");
    expect(checkThreads(join(clone, "c", "_threads")).modified.map((m) => m.file)).toEqual([edited]);
  });

  it("names a post whose file name is not ASCII, instead of dropping it", () => {
    const { dir, a, threads } = space();
    const name = "2026-11-07T10-00-00-000Z-msg_é-ü.md";
    writeFileSync(join(a.path, name), "---\nid: msg_accent\ndate: 2026-11-07T10:00:00.000Z\nkind: post\nauthor: A\n---\n\nAccent.\n");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "Accent post");
    appendFileSync(join(a.path, name), "\nEdited.\n");
    git(dir, "commit", "-qam", "Edit the accent post");
    expect(checkThreads(threads).modified.map((m) => m.file)).toEqual([name]);
  });

  it("matches a slug literally, and sees both ends of a staged rename", () => {
    const { dir, a, b, threads } = space();
    expect(checkThreads(threads, "*").modified).toEqual([]);
    const file = files(a.path)[0];
    git(dir, "mv", join("_threads", "alpha", file), join("_threads", "beta", file));
    const found = checkThreads(threads).modified.map((m) => `${m.thread}/${m.file}`).sort();
    expect(found).toEqual([`alpha/${file}`, `beta/${file}`]);
    expect(b.slug).toBe("beta");
  });
});
