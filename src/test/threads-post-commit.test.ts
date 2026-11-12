// The tool that writes a local post commits it (the human, 2026-11-12): that one path, never pushed,
// and a commit that fails never loses the post.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createThread } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";
import { allowedFlags } from "../agent-tools/flags.js";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A Space that is a Git repository with an identity, a committed Thread and a clean tree. */
function repo(options: { identity?: boolean; git?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "is-post-commit-")); temp.push(dir);
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), "---\nname: Fixture\nsummary: Test\n---\n");
  const thread = createThread("t", "T", dir);
  if (options.git !== false) {
    git(dir, "init", "-q");
    if (options.identity !== false) { git(dir, "config", "user.name", "Fixture Person"); git(dir, "config", "user.email", "fixture@example.org"); }
    else git(dir, "config", "user.useConfigOnly", "true");
    git(dir, "config", "commit.gpgsign", "false");
    if (options.identity !== false) { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "fixture"); }
  }
  return { dir, thread };
}

async function run(dir: string, verb: "post" | "close", flags: Record<string, string | boolean>, json = true) {
  const old = process.cwd(); process.chdir(dir);
  const write = process.stdout.write; const errWrite = process.stderr.write;
  let out = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run([verb, "t"], { author: "Tester", message: "Hello", ...flags }, { json, quiet: !json ? false : true, yes: false, help: false });
    return { code, out, result: json ? JSON.parse(out) : undefined };
  } finally { process.stdout.write = write; process.stderr.write = errWrite; process.chdir(old); }
}

describe("threads post commits the post it writes", () => {
  it("commits that one file as its own commit, names the Thread and post, and does not push", async () => {
    const { dir, thread } = repo();
    const before = git(dir, "rev-list", "--count", "HEAD");
    const { code, result } = await run(dir, "post", {});
    expect(code).toBe(0);
    expect(result).toMatchObject({ committed: true, commit: git(dir, "rev-parse", "HEAD"), state: "committed" });
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe(String(Number(before) + 1));
    expect(git(dir, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([`Thread t: post ${result.id}`, "", `_threads/t/${basename(result.path)}`]);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Fixture Person <fixture@example.org>");
    expect(thread.path).toBeTruthy();
  });

  it("leaves an unrelated staged file staged and uncommitted, and other untracked files untracked", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "staged.md"), "someone else's work\n"); git(dir, "add", "staged.md");
    writeFileSync(join(dir, "untracked.md"), "not mine\n");
    const { result } = await run(dir, "post", {});
    expect(result.committed).toBe(true);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("staged.md");
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe(`_threads/t/${basename(result.path)}`);
    expect(git(dir, "status", "--porcelain").split("\n").sort()).toEqual(["?? untracked.md", "A  staged.md"]);
  });

  it("leaves another post of the same Thread, written earlier and still untracked, untracked", async () => {
    const { dir } = repo();
    const first = await run(dir, "post", { "no-commit": true });
    const second = await run(dir, "post", {});
    expect(second.result.committed).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe(`?? _threads/t/${basename(first.result.path)}`);
  });

  it("--no-commit leaves the post untracked and says why in the result", async () => {
    const { dir } = repo();
    const head = git(dir, "rev-parse", "HEAD");
    const { code, result } = await run(dir, "post", { "no-commit": true });
    expect(code).toBe(0);
    expect(result).toMatchObject({ committed: false, reason: "--no-commit", state: "local" });
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe(`?? _threads/t/${basename(result.path)}`);
  });

  it("a failing hook keeps the post, exits 0, leaves it unstaged and says written, not committed", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n"); chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
    const head = git(dir, "rev-parse", "HEAD");
    const text = await run(dir, "post", {}, false);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/Written, not committed: .*lint says no/);
    const posts = readdirSync(join(dir, "_threads", "t")).filter((f) => f.includes("msg_"));
    expect(posts).toHaveLength(1);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(git(dir, "status", "--porcelain")).toMatch(/^\?\? _threads\/t\/.*msg_/);
    const json = await run(dir, "post", {});
    expect(json.code).toBe(0);
    expect(json.result.committed).toBe(false);
    expect(json.result.reason).toMatch(/lint says no/);
    expect(existsSync(json.result.path)).toBe(true);
  });

  it("no Git identity keeps the post and says so", async () => {
    const { dir } = repo({ identity: false });
    const { code, result } = await run(dir, "post", {});
    expect(code).toBe(0);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/identity|tell me who you are|user\.name|empty ident/i);
    expect(existsSync(result.path)).toBe(true);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
  });

  it("a held index lock keeps the post, leaves the lock alone and names it", async () => {
    const { dir } = repo();
    const lock = join(dir, ".git", "index.lock"); writeFileSync(lock, "");
    const { code, result } = await run(dir, "post", {});
    expect(code).toBe(0);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/index\.lock/);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  }, 15_000);

  it("a folder outside any Git repository still writes the post and says why it was not committed", async () => {
    const { dir } = repo({ git: false });
    const { code, result } = await run(dir, "post", {});
    expect(code).toBe(0);
    expect(result).toMatchObject({ committed: false, reason: "this folder is not in a Git repository" });
    expect(existsSync(result.path)).toBe(true);
  });

  it("threads close commits its closure post the same way, and --no-commit skips it", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "staged.md"), "x\n"); git(dir, "add", "staged.md");
    const { code, result } = await run(dir, "close", {});
    expect(code).toBe(0);
    expect(result).toMatchObject({ kind: "closure", committed: true });
    expect(git(dir, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([`Thread t: closure ${result.id}`, "", `_threads/t/${basename(result.path)}`]);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("staged.md");
    const other = repo();
    const skipped = await run(other.dir, "close", { "no-commit": true });
    expect(skipped.result).toMatchObject({ kind: "closure", committed: false, reason: "--no-commit" });
  });

  it("puts the post's name in the commit body", async () => {
    const { dir } = repo();
    await run(dir, "post", { name: "A readable title" });
    expect(git(dir, "log", "-1", "--format=%b")).toBe("A readable title");
  });

  it("is a local flag only: a hosted post is untouched", () => {
    expect(allowedFlags("threads.post", "local").has("no-commit")).toBe(true);
    expect(allowedFlags("threads.post", "hosted").has("no-commit")).toBe(false);
    expect(allowedFlags("threads.close", "local").has("no-commit")).toBe(true);
    expect(allowedFlags("threads.close", "hosted").has("no-commit")).toBe(false);
  });
});
