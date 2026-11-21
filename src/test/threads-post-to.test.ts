import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadPost } from "@ideaspaces/protocol";
import { threadsCommand } from "../commands/threads.js";
import { postCommand } from "../commands/post.js";

const ROOT_ID = "n_0123456789abcdef01234567";
const HOSTED = `x_${"a".repeat(32)}`;
const temp: string[] = [];
const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

/** A Space with one Thread, in a repository with a name and email of its own. */
function space(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "is-post-to-"))); temp.push(dir);
  process.env.HOME = dir;
  process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global-gitconfig");
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: Agreement — Fixture\nsummary: Keeps the fixture.\nroot_node_id: ${ROOT_ID}\n---\n`);
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  return dir;
}

async function run(command: typeof threadsCommand | typeof postCommand, dir: string, args: string[], options: Record<string, string | boolean>, json = true) {
  const before = process.cwd(); process.chdir(dir);
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = await command.run(args, options, { json, quiet: false, yes: false, help: false });
    return { code, json: json && code === 0 && out ? JSON.parse(out) : undefined, out, err };
  } catch (error) {
    return { code: 1, json: undefined, out, err: err + (error instanceof Error ? error.message : String(error)) };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(before); }
}

const posts = (thread: string) => readdirSync(thread).filter((name) => name.endsWith(".md") && name !== "README.md");
const toOf = (path: string) => (parseThreadPost(readFileSync(path, "utf8"), path) as any).post.to;

describe("who a post asks (--to)", () => {
  it("writes the post's to, trimmed and without repeats, says so, and reads back on open", async () => {
    const dir = space();
    const made = await run(threadsCommand, dir, ["new", "decision"], { about: "Decision" });
    const asked = await run(threadsCommand, dir, ["post", "decision"], { message: "Which one?", to: " human , d-pm,human" });
    expect(asked.code).toBe(0);
    expect(asked.json).toMatchObject({ to: ["human", "d-pm"], committed: true });
    expect(readFileSync(asked.json.path, "utf8")).toMatch(/\nto:\n {2}- human\n {2}- d-pm\n/);
    expect(toOf(asked.json.path)).toEqual(["human", "d-pm"]);
    const one = await run(threadsCommand, dir, ["post", "decision"], { message: "And you?", to: "person:ernest" });
    expect(readFileSync(one.json.path, "utf8")).toContain("\nto: person:ernest\n");
    const opened = await run(threadsCommand, dir, ["open", "decision"], { depth: "full" });
    expect(opened.json.posts.find((post: any) => post.id === asked.json.id).to).toEqual(["human", "d-pm"]);
    const text = await run(threadsCommand, dir, ["open", "decision"], { depth: "full" }, false);
    expect(text.out).toContain("· asks: human, d-pm");
    expect(made.code).toBe(0);
  });

  it("refuses a to that names no one, an empty name, too many or too long, and writes nothing", async () => {
    const dir = space();
    await run(threadsCommand, dir, ["new", "decision"], { about: "Decision" });
    const thread = join(dir, "_threads", "decision");
    const before = posts(thread).length;
    for (const to of ["", " , ", "human,,d-pm", Array.from({ length: 21 }, (_, i) => `n${i}`).join(","), "x".repeat(201), true] as const) {
      const result = await run(threadsCommand, dir, ["post", "decision"], { message: "Which one?", to });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/--to (names who the post asks|requires a value)/);
    }
    expect(posts(thread).length).toBe(before);
  });

  it("is local only: a hosted post refuses it before anything is sent", async () => {
    const dir = space();
    const result = await run(threadsCommand, dir, ["post", HOSTED], { message: "Which one?", to: "human", "reply-to": "msg_1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("The service doesn't keep who a post asks yet; --to is for local Threads.");
  });

  it("is the same on the post verb", async () => {
    const dir = space();
    await run(threadsCommand, dir, ["new", "decision"], { about: "Decision" });
    const result = await run(postCommand, dir, ["decision"], { message: "Which one?", to: "d-pm" });
    expect(result.code).toBe(0);
    const latest = posts(join(dir, "_threads", "decision")).sort().at(-1)!;
    expect(toOf(join(dir, "_threads", "decision", latest))).toEqual(["d-pm"]);
  });
});
