import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { makeAgentCommand } from "../commands/agent.js";
import { threadsCommand } from "../commands/threads.js";
import { claudeConversationOps } from "../claude/local-conversation-ops.js";
import { localConversationOps as piConversationOps } from "../pi/local-conversation-ops.js";
import { composeLocalConversationOps } from "../local/runtime.js";
import { assembleLaunchText, MAX_ORIENTATION_BYTES } from "../local/launch-text.js";
import { loadMapOrientation } from "../local/map-orientation.js";
import { appendPost, createThread, loadThread } from "../local/threads.js";
import type { GlobalFlags } from "../types.js";

// Each test builds a Git repo and reads a Map through Git; a Windows runner is several times slower.
vi.setConfig({ testTimeout: 90_000 });

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const ROOT_ID = "n_0123456789abcdef01234567";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

let originalHome: string | undefined;
let originalCwd: string;
let out: string[];
let err: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = tempDir("lt-home-");
  out = [];
  err = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stdout = () => out.join("");
const stderr = () => err.join("");

interface Fixture {
  root: string;
  pov: string;
  pin: string;
  /** The Thread holding the Note, and the Note's post. */
  note: { dir: string; id: string; file: string };
  /** A Thread whose opening post carries a Map and is attached to the Note. */
  launch: { dir: string; id: string; file: string };
}

/**
 * A Space the way the app keeps one: the Note is committed, the launching post comes after the pin
 * its Map names, so it cannot be read at that pin and the Note has to be a member.
 */
function fixture(options: { noteBody?: string; agreement?: string; extra?: number; attach?: boolean; depth?: string; unicode?: boolean } = {}): Fixture {
  const root = tempDir("lt-space-");
  const pov = tempDir("lt-pov-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Local Space\nroot_node_id: ${ROOT_ID}\n---\n# Space\n`);
  mkdirSync(join(pov, "_agent"));
  writeFileSync(join(pov, "_agent", "agreement.md"), "---\nname: Agreement — Reader\n---\n# Reader\nReads first.\n");
  mkdirSync(join(root, "docs"));
  const extra = options.extra ?? 3;
  for (let i = 0; i < extra; i++) {
    writeFileSync(join(root, "docs", `n${i}.md`), `---\nname: Note ${i}\nsummary: Summary of note ${i}\n---\n# Note ${i}\n${(options.unicode ? "Écrit à l’été — naïve → déjà vu, 日本語. " : "Long line of text for the surface of this note. ").repeat(40)}\n`);
  }
  const target = createThread("target", "The target Thread", root);
  if (options.agreement) writeFileSync(join(target.path, "_agent", "agreement.md"), options.agreement);
  const note = appendPost(target.path, { body: options.noteBody ?? "NOTE-BODY-ONCE: what the session continues from.", summary: "The Note", author: "Scout" });
  git("add", "-A"); git("commit", "-m", "pin");
  const pin = git("rev-parse", "HEAD");
  const map = {
    roots: [{ root_node_id: ROOT_ID, sha: pin }],
    members: [
      { root: 0, position: `_threads/target/${note.post.path}`, depth: options.depth ?? "full", summary: "The Note itself" },
      ...Array.from({ length: extra }, (_, i) => ({ root: 0, position: `docs/n${i}.md`, depth: "full", summary: `Doc ${i}` })),
    ],
  };
  const launching = createThread("launch", "Launch from a point", root, options.attach === false ? undefined : `post:${note.post.id}`);
  const opening = appendPost(launching.path, { body: "Continue from the Note.", summary: "Dispatch", author: "UI/UX", map, ...(options.attach === false ? {} : { attachedTo: `post:${note.post.id}` }) });
  return {
    root, pov, pin,
    note: { dir: target.path, id: note.post.id, file: join(target.path, note.post.path) },
    launch: { dir: launching.path, id: opening.post.id, file: opening.path },
  };
}

describe("threads launch-text", () => {
  it("assembles the Map, the Agreement and the pinned Note, and the Note loads once", async () => {
    const f = fixture();
    const result = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root });
    expect(result.schema).toBe("ideaspaces.threads.launch-text.v1");
    // Order is agent run's: Map, selected Agreement, pinned Thread frame.
    const map = result.text.indexOf("[IdeaSpaces Map]");
    const pov = result.text.indexOf("[Selected agreement POV:");
    const frame = result.text.indexOf("[Pinned local Thread");
    expect(map).toBe(0);
    expect(pov).toBeGreaterThan(map);
    expect(frame).toBeGreaterThan(pov);
    // The Note is the post the opening post is attached to: member 0, at the Map's pin.
    expect(result.note).toMatchObject({ thread: "target", post: f.note.id, member: 0, pin: f.pin, closed: false });
    // Once: in the frame, with its body; the Map names the member and says where it went.
    expect(result.text.split("NOTE-BODY-ONCE").length - 1).toBe(1);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toMatchObject({ index: 0, declared: "full" });
    expect(result.text).toContain("loaded whole as this launch's Note, below; not repeated here (declared full)");
    // Other members still arrive at their depth.
    expect(result.text).toContain("Summary of note 0");
    expect(result.lowered).toEqual([]);
    expect(result.cut).toEqual([]);
    expect(result.bytes).toBe(Buffer.byteLength(result.text));
  });

  // The stand-in runtime is a shell script, as in the other end-to-end runtime tests.
  it.skipIf(process.platform === "win32")("matches what agent run appends for the same inputs, and the cap counts the Map", async () => {
    // Long enough that the Map must lower to leave the Agreement and the frame their room.
    const f = fixture({ extra: 12, agreement: `---\nname: Agreement\nsummary: Terms\n---\n# Terms\n${"A clause of the Thread's terms. ".repeat(180)}\n` });
    const capture = join(f.pov, "captured.txt");
    const bin = join(f.pov, "claude");
    writeFileSync(join(f.pov, "claude.cjs"), `
const fs = require("node:fs");
const args = process.argv.slice(2);
const id = args[args.indexOf("--resume") + 1] || args[args.indexOf("--session-id") + 1];
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume(); process.stdin.on("data", () => {}); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capture)}, args[args.indexOf("--append-system-prompt") + 1] || "");
  write({ type: "system", subtype: "init", session_id: id, model: "claude-fake", cwd: process.cwd() });
  write({ type: "stream_event", event: { type: "message_start" } });
  write({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
});
`);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(f.pov, "claude.cjs")}" "$@"\n`);
    chmodSync(bin, 0o755);

    const verb = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root });
    expect(verb.bytes).toBeLessThanOrEqual(MAX_ORIENTATION_BYTES);
    expect(verb.lowered.length).toBeGreaterThan(0);
    // The Map takes the room left, so its budget is below the usual 12,000.
    expect(verb.map.budget).toBeLessThan(12_000);

    const agentCmd = makeAgentCommand(composeLocalConversationOps({ pi: piConversationOps, claude: claudeConversationOps }));
    process.chdir(f.root);
    const code = await agentCmd.run(["run", f.pov], {
      runtime: "claude", "claude-bin": bin, message: "State the goal.",
      thread: f.note.dir, "thread-map": f.launch.file, "thread-member": "0", map: f.launch.file,
    }, JSON_GLOBAL);
    expect(code, stderr()).toBe(0);
    const appended = readFileSync(capture, "utf8");
    expect(appended).toBe(verb.text);
    // `cut` names every member the text says it lowered.
    const said = [...appended.matchAll(/\[(\d+)\] (\w+)→(\w+)/g)].map((m) => `${m[1]} ${m[2]}→${m[3]}`);
    expect(verb.cut.filter((c) => c.kind === "depth").map((c) => c.kind === "depth" ? `${c.index} ${c.declared}→${c.effective}` : "")).toEqual(said);
    for (const entry of verb.cut) if (entry.kind === "depth") expect(entry.address).toMatch(/^@.*\/\/docs\/n\d+\.md$/);
  }, 30_000);

  it("merges a member only when it is the same post at the same pin", async () => {
    const f = fixture();
    const position = `_threads/target/${basename(f.note.file)}`;
    const note = (sha: string) => ({ roots: [{ root_node_id: ROOT_ID, sha }], members: [{ root: 0, position }] });
    expect((await loadMapOrientation(f.launch.file, f.root, { loadedAsNote: note(f.pin) })).merged).toHaveLength(1);
    // Another pin is another version of the post: the Map reads it, and nothing is claimed as loaded once.
    const other = await loadMapOrientation(f.launch.file, f.root, { loadedAsNote: note("b".repeat(40)) });
    expect(other.merged).toEqual([]);
    expect(other.text).not.toContain("loaded whole as this launch's Note");
  });

  it("refuses a launch whose Agreement and frame alone do not fit, before any Map is read", async () => {
    const f = fixture();
    writeFileSync(join(f.pov, "_agent", "agreement.md"), `---\nname: Big\n---\n${"x".repeat(17_000)}\n`);
    await expect(assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root })).rejects.toThrow(/Combined Agreement and Thread orientation exceeds 16 KiB: \d+ bytes \(Agreement \d+, Thread frame \d+\)/);
  });

  it("converges when multi-byte text makes bytes outrun the character budget", async () => {
    const f = fixture({ extra: 12, unicode: true, agreement: `---\nname: Agreement\nsummary: Terms\n---\n# Terms\n${"A clause of the Thread's terms. ".repeat(180)}\n` });
    const result = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root });
    expect(result.bytes).toBeLessThanOrEqual(MAX_ORIENTATION_BYTES);
    const mapBytes = Buffer.byteLength(result.text.slice(0, result.map.chars));
    expect(mapBytes).toBeGreaterThan(result.map.chars);
    // The first read is as many characters as there are bytes of room; converging means it read again with fewer.
    const room = MAX_ORIENTATION_BYTES - (result.bytes - mapBytes);
    expect(result.map.budget).toBeLessThan(room);
    expect(result.lowered.length).toBeGreaterThan(0);
  });

  it("never lets --budget raise the Map past the room the cap leaves", async () => {
    const f = fixture({ extra: 12, agreement: `---\nname: Agreement\nsummary: Terms\n---\n# Terms\n${"A clause of the Thread's terms. ".repeat(180)}\n` });
    const result = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root, budget: 50_000 });
    expect(result.map.budget).toBeLessThan(50_000);
    expect(result.bytes).toBeLessThanOrEqual(MAX_ORIENTATION_BYTES);
    const small = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root, budget: 6_000 });
    expect(small.map.budget).toBe(6_000);
  }, 30_000);

  it("says when the room left is smaller than any Map can fit", async () => {
    const f = fixture({ extra: 45, agreement: `---\nname: Agreement\n---\n${"A clause. ".repeat(1060)}\n` });
    await expect(assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, pov: f.pov, cwd: f.root })).rejects.toThrow(/leave \d+ of 16384 bytes for the Map/);
  }, 60_000);

  it("asks for --member when the post is not in its Map and is attached to nothing in it", async () => {
    const f = fixture({ attach: false });
    await expect(assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, cwd: f.root })).rejects.toThrow(/is attached to no post[\s\S]*--member <ordinal>[\s\S]*\[0\] _threads\/target/);
    const chosen = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, member: "0", cwd: f.root });
    expect(chosen.note.post).toBe(f.note.id);
    await expect(assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, member: "9", cwd: f.root })).rejects.toThrow(/zero-based ordinal of the post's Map \(0 to 3\)/);
  });

  it("refuses a post with no Map, an unknown post and a malformed id, saying what to do", async () => {
    const f = fixture();
    const plain = appendPost(f.launch.dir, { body: "Just talk.", summary: "No Map here" });
    await expect(assembleLaunchText({ thread: f.launch.dir, post: plain.post.id, cwd: f.root })).rejects.toThrow(/carries no Map/);
    await expect(assembleLaunchText({ thread: f.launch.dir, post: "msg_00000000-0000-0000-0000-000000000000", cwd: f.root })).rejects.toThrow(/has no post msg_0+/);
    await expect(assembleLaunchText({ thread: f.launch.dir, post: "latest", cwd: f.root })).rejects.toThrow(/needs a post id/);
  });

  it("reads the Note at its pin, not the working tree, and does not write", async () => {
    const f = fixture();
    writeFileSync(join(f.note.dir, "_agent", "agreement.md"), "---\nname: Wrong HEAD frame\n---\n# Changed after pin\n");
    const before = loadThread(f.note.dir).posts.length + loadThread(f.launch.dir).posts.length;
    const result = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, cwd: f.root });
    expect(result.text).not.toContain("Changed after pin");
    expect(loadThread(f.note.dir).posts.length + loadThread(f.launch.dir).posts.length).toBe(before);
  });

  it("reads from a closed Thread, which agent run would refuse to write a snapshot into", async () => {
    const f = fixture();
    appendPost(f.note.dir, { body: "Done.", kind: "closure" });
    const result = await assembleLaunchText({ thread: f.launch.dir, post: f.launch.id, cwd: f.root });
    expect(result.note.closed).toBe(true);
  });

  it("is a threads verb: JSON result by default flags, the text itself for a person, and named refusals", async () => {
    const f = fixture();
    process.chdir(f.root);
    expect(await threadsCommand.run(["launch-text", f.launch.dir], { post: f.launch.id }, JSON_GLOBAL)).toBe(0);
    const json = JSON.parse(stdout());
    expect(json).toMatchObject({ schema: "ideaspaces.threads.launch-text.v1", note: { member: 0 }, merged: [{ index: 0 }] });
    expect(typeof json.text).toBe("string");

    out = [];
    expect(await threadsCommand.run(["launch-text", f.launch.dir], { post: f.launch.id }, { ...JSON_GLOBAL, json: false })).toBe(0);
    expect(stdout()).toContain("[IdeaSpaces Map]");
    expect(stdout()).toContain("[End pinned local Thread]");

    out = []; err = [];
    expect(await threadsCommand.run(["launch-text", f.launch.dir], {}, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--post <msg_id> is required");
    err = [];
    expect(await threadsCommand.run(["launch-text", f.launch.dir], { post: f.launch.id, budget: "0" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--budget must be a positive integer");
    err = [];
    expect(await threadsCommand.run(["launch-text", f.launch.dir], { post: f.launch.id, bogus: "1" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Unknown flag for threads launch-text: --bogus");
    err = [];
    expect(await threadsCommand.run(["launch-text", "x_abcdefgh12345678"], { post: f.launch.id }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("reads a local Thread");
  });
});
