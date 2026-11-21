import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";

const ROOT_ID = "n_0123456789abcdef01234567";
const temp: string[] = [];
const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, IDEASPACES_READER: process.env.IDEASPACES_READER };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }
function space(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "is-inbox-"))); temp.push(dir);
  process.env.HOME = dir;
  process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global-gitconfig");
  delete process.env.IDEASPACES_READER;
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: Agreement — Home\nsummary: Home.\nroot_node_id: ${ROOT_ID}\n---\n`);
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.name", "er"); git(dir, "config", "user.email", "er@example.test");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  return dir;
}

async function threads(dir: string, args: string[], options: Record<string, string | boolean>, json = true) {
  const before = process.cwd(); process.chdir(dir);
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run(args, options, { json, quiet: false, yes: false, help: false });
    return { code, json: json && code === 0 && out ? JSON.parse(out) : undefined, out, err };
  } catch (error) {
    return { code: 1, json: undefined, out, err: err + (error instanceof Error ? error.message : String(error)) };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(before); }
}
const post = async (dir: string, thread: string, options: Record<string, string>) => (await threads(dir, ["post", thread], options)).json;
const inbox = async (dir: string, options: Record<string, string | boolean> = { as: "human,er" }) => (await threads(dir, ["inbox"], options)).json;

describe("threads inbox", () => {
  it("lists what asks you, oldest first, until you answer it or read it; never your own, never someone else's", async () => {
    const dir = space();
    await threads(dir, ["new", "lane"], { about: "Lane" });
    await threads(dir, ["new", "quiet"], { about: "Quiet" });
    const first = await post(dir, "lane", { message: "Which colour should the button be?", author: "d-pm", to: "human", name: "Colour" });
    const second = await post(dir, "lane", { message: "Save or Keep?", author: "d-pm", to: "er,UI/UX" });
    await post(dir, "lane", { message: "For someone else.", author: "d-pm", to: "Integrator" });
    await post(dir, "lane", { message: "I ask myself.", author: "er", to: "human" });

    let read = await inbox(dir);
    expect(read.schema).toBe("ideaspaces.threads.inbox.v1");
    expect(read.asks.map((ask: any) => [ask.post.id, ask.matched])).toEqual([[first.id, ["human"]], [second.id, ["er"]]]);
    expect(read.asks[0]).toMatchObject({ slug: "lane", thread_name: "Lane", to: ["human"],
      post: { author: "d-pm", name: "Colour", excerpt: "Which colour should the button be?" } });
    expect(read.sides).toEqual({ local: { complete: true }, hosted: { state: "not_checked" } });

    // Answered: a later post of yours that replies to it.
    await post(dir, "lane", { message: "Blue.", author: "er", "reply-to": first.id });
    read = await inbox(dir);
    expect(read.asks.map((ask: any) => ask.post.id)).toEqual([second.id]);
    // Read: your position passes it.
    await threads(dir, ["ack", "lane"], { through: second.id });
    expect((await inbox(dir)).asks).toEqual([]);
  });

  it("keeps each reader's own position: a firefly's read leaves the person's asks", async () => {
    const dir = space();
    await threads(dir, ["new", "lane"], { about: "Lane" });
    const ask = await post(dir, "lane", { message: "Can you check?", author: "d-pm", to: "human,Integrator" });
    await threads(dir, ["ack", "lane"], { through: ask.id, reader: "integrator" });
    expect((await inbox(dir, { as: "Integrator", reader: "integrator" })).asks).toEqual([]);
    expect((await inbox(dir, { as: "human" })).asks.map((row: any) => row.post.id)).toEqual([ask.id]);
  });

  it("then says what moved since your position, with each Thread's newest post; the first look sets a baseline", async () => {
    const dir = space();
    await threads(dir, ["new", "lane"], { about: "Lane" });
    const first = await inbox(dir);
    expect(first.moved).toMatchObject({ baseline: true, threads: [] });
    await post(dir, "lane", { message: "News.", author: "d-pm", name: "What moved" });
    const later = await inbox(dir);
    expect(later.moved.baseline).toBe(false);
    expect(later.moved.threads).toEqual([expect.objectContaining({ slug: "lane", name: "Lane", new_posts: 1, newest: expect.objectContaining({ author: "d-pm", name: "What moved" }) })]);
    expect(later.asks).toEqual([]);
  });

  it("says who you must be, and reports the hosted side without failing the local one", async () => {
    const dir = space();
    const none = await threads(dir, ["inbox"], {});
    expect(none.code).toBe(1);
    expect(none.err).toContain("Say who you are in a post's to: --as");
    await threads(dir, ["new", "lane"], { about: "Lane" });
    const ask = await post(dir, "lane", { message: "Here?", author: "d-pm", to: "human" });
    const read = await inbox(dir, { as: "human", hosted: true });
    expect(read.asks.map((row: any) => row.post.id)).toEqual([ask.id]);
    expect(read.sides.hosted.state).toBe("unavailable");
    expect(read.hosted).toEqual([]);
    const text = await threads(dir, ["inbox"], { as: "human" }, false);
    expect(text.out).toContain("Asks you (1):");
    expect(text.out).toContain("Answer with threads post <thread> --reply-to <post-id>");
  });
});
