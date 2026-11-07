// cli#312: a writer's words are single lines everywhere `threads open` and `threads check` print them.
// This walks every rung and variant of both commands over a Thread whose every writer-chosen field carries a line break
// followed by FORGED, and fails if any output line starts with it, in text or as a string in the JSON.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveSpace } from "../auth/spaces.js";
import { createThread, loadThread, readCursor } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

const initialCwd = process.cwd();
const initialHome = process.env.HOME;
const temp: string[] = [];
afterEach(() => { process.chdir(initialCwd); process.env.HOME = initialHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Eve", "-c", "user.email=e@example.test", ...args], { cwd, encoding: "utf8" }).trim();
/** A field value that ends its line and starts a forged one. */
const forge = (field: string) => `before\nFORGED-${field} after`;
const y = (value: unknown) => JSON.stringify(value);
const ROOT_ID = "n_0123456789abcdef01234567";

function space() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-display-walk-"))); temp.push(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Agreement — Walk\nsummary: Test\nagreement: agent:repo:${ROOT_ID}\nroot_node_id: ${ROOT_ID}\n---\n`);
  git(root, "init", "-q", "-b", "main");
  process.env.HOME = root;
  const t = createThread("decision", "A decision", root);
  const file = (name: string, front: string) => writeFileSync(join(t.path, name), `---\n${front}---\n\nA plain body line.\n`);
  file("2026-11-07T10-00-00-000Z-msg_a.md", `id: msg_a\ndate: 2026-11-07T10:00:00.000Z\nkind: post\nauthor: ${y(forge("author"))}\nname: ${y(forge("name"))}\nsummary: ${y(forge("summary"))}\ntags: [${y(forge("tag"))}]\nactor_ref: ${y(forge("actor"))}\n`);
  file("2026-11-07T10-01-00-000Z-msg_b.md", `id: msg_b\ndate: 2026-11-07T10:01:00.000Z\nkind: post\nin_reply_to: [msg_a, ${y(forge("reply"))}]\nauthor: ${y(forge("author-b"))}\nname: ${y(forge("name-b"))}\n`);
  file("2026-11-07T10-02-00-000Z-msg_s.md", `id: msg_s\ndate: 2026-11-07T10:02:00.000Z\nkind: snapshot\nin_reply_to: msg_b\nauthor: ${y(forge("snapshot-author"))}\nname: ${y(forge("snapshot-name"))}\nsummary: ${y(forge("snapshot-summary"))}\n`);
  file("2026-11-07T10-03-00-000Z-msg_m.md", `id: msg_m\ndate: 2026-11-07T10:03:00.000Z\nkind: mark\nmark: ${y(forge("mark"))}\nin_reply_to: msg_b\nauthor: ${y(forge("mark-author"))}\n`);
  // A post with malformed fields, each carrying a forged line: the protocol keeps it and warns, and none of it may print raw.
  file("2026-11-07T10-05-00-000Z-msg_w.md", `id: msg_w\ndate: ${y(forge("date"))}\nkind: ${y(forge("kind"))}\ntags: ${y(forge("tags-not-a-list"))}\nreferences: ${y(forge("refs"))}\nin_reply_to: ${y(forge("reply-not-an-id"))}\nattached_to: ${y(forge("attached"))}\nmap: [broken]\nsupersedes: ${y(forge("supersedes"))}\nauthor: ${y(forge("author-w"))}\n`);
  writeFileSync(join(t.path, "README.md"), `---\nname: ${y(forge("thread-name"))}\nsummary: ${y(forge("thread-summary"))}\n---\n\n# Walk\n`);
  const child = createThread("child", "A child", root, "post:msg_a");
  writeFileSync(join(child.path, "README.md"), `---\nname: ${y(forge("child-name"))}\nsummary: ${y(forge("child-summary"))}\n---\n\n# Child\n`);
  writeFileSync(join(child.path, "2026-11-07T11-00-00-000Z-msg_c0.md"), `---\nid: msg_c0\ndate: 2026-11-07T11:00:00.000Z\nkind: post\nattached_to: post:msg_a\nauthor: Eve\n---\n\nOpening of the child.\n`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "walk");
  appendFileSync(join(t.path, "2026-11-07T10-00-00-000Z-msg_a.md"), "\nEdited.\n");
  git(root, "commit", "-qam", "edit msg_a");
  return { root, thread: t };
}

/** Text mode returns everything printed; JSON mode returns stdout alone to parse, and what went to stderr is checked here. */
async function run(args: string[], flags: Record<string, string | boolean>, json: boolean) {
  let out = "", err = "";
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try { await threadsCommand.run(args, flags, { json, quiet: false, yes: false, help: false }); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  if (json) { noForgedLine(err, `${args.join(" ")} (stderr beside JSON)`); return out; }
  return err + out;
}
/** Output the commands print verbatim by design: a post's body and the files themselves. */
const VERBATIM = new Set(["body", "raw_post", "pinned", "frame", "reference", "readme"]);
function strings(value: unknown, key = "", out: string[] = []): string[] {
  if (typeof value === "string") { if (!VERBATIM.has(key)) out.push(value); }
  else if (Array.isArray(value)) for (const item of value) strings(item, key, out);
  else if (value && typeof value === "object") for (const [k, item] of Object.entries(value)) strings(item, k, out);
  return out;
}
function noForgedLine(text: string, where: string) {
  const forged = text.split("\n").find((line) => line.trimStart().startsWith("FORGED"));
  expect(forged, `${where}: a line starts with a writer's FORGED text: ${forged}`).toBeUndefined();
}

const DEPTHS = ["name", "summary", "children", "surface", "full"] as const;
const VARIANTS: Array<[string, Record<string, string | boolean>]> = [
  ["default", {}], ["limit 1", { limit: "1" }], ["newer, limit 2", { order: "newer", limit: "2" }],
  ["since a post", { since: "msg_a" }], ["new", { new: true }],
];

describe("threads open prints no writer's line break as a new line", () => {
  it("at every rung and variant, in text and in JSON", async () => {
    const { root } = space();
    process.chdir(root);
    let walked = 0;
    for (const depth of DEPTHS) for (const [label, extra] of VARIANTS) {
      if (depth === "name" && ("limit" in extra || "order" in extra)) continue;
      if (depth === "children" && "new" in extra) continue;
      const flags = { depth, ...extra };
      noForgedLine(await run(["open", "decision"], flags, false), `open ${depth} / ${label} (text)`);
      const data = JSON.parse(await run(["open", "decision"], flags, true));
      for (const text of strings(data)) expect(text, `open ${depth} / ${label} (json)`).not.toMatch(/\n[ \t]*FORGED/);
      walked++;
    }
    for (const depth of ["summary", "full"]) {
      noForgedLine(await run(["open", "decision"], { depth, post: "msg_b" }, false), `open ${depth} --post (text)`);
      noForgedLine(await run(["open", "decision"], { depth: "children", post: "msg_a" }, false), "open children --post msg_a (child Threads)");
      walked++;
    }
    expect(walked).toBeGreaterThan(20);
  });

  it("on the child Thread's own name and summary, and on the parent it shows", async () => {
    const { root } = space();
    process.chdir(root);
    for (const depth of ["name", "summary", "children"]) noForgedLine(await run(["open", "child"], { depth }, false), `open child ${depth}`);
    expect(await run(["open", "decision"], { depth: "children" }, false)).toContain("Child Threads");
  });

  it("on a pinned read selected by a Map member", async () => {
    const { root, thread } = space();
    const pin = git(root, "rev-parse", "HEAD");
    const agent = realpathSync(mkdtempSync(join(tmpdir(), "is-display-agent-"))); temp.push(agent);
    mkdirSync(join(agent, "_agent"));
    writeFileSync(join(agent, "_agent", "agreement.md"), "---\nname: Agreement — Reader\nsummary: Test\nagreement: agent:repo:n_ffffffffffffffffffffffff\nroot_node_id: n_ffffffffffffffffffffffff\n---\n");
    git(agent, "init", "-q", "-b", "main"); git(agent, "add", "-A"); git(agent, "commit", "-qm", "agent");
    const map = join(agent, "selection.json");
    writeFileSync(map, JSON.stringify({ map: { roots: [{ root_node_id: ROOT_ID, sha: pin }], members: [{ root: 0, position: `_threads/decision/${basename(join(thread.path, "2026-11-07T10-00-00-000Z-msg_a.md"))}`, depth: "full" }] } }));
    process.env.HOME = agent; process.chdir(agent);
    saveSpace(root, { repo_id: "repo_walk", slug: "walk", namespace: "team", root_node_id: ROOT_ID });
    for (const depth of ["name", "summary", "children"]) {
      noForgedLine(await run(["open", "decision"], { map, member: "0", depth }, false), `pinned ${depth} (text)`);
      const data = JSON.parse(await run(["open", "decision"], { map, member: "0", depth }, true));
      expect(data.pin, "the pinned read must have succeeded, or this walks an error message").toBe(pin);
      for (const text of strings(data)) expect(text, `pinned ${depth} (json)`).not.toMatch(/\n[ \t]*FORGED/);
    }
  });
});

describe("threads check prints no writer's line break as a new line", () => {
  it("in text and in JSON, for the Space and for one Thread", async () => {
    const { root, thread } = space();
    process.chdir(root);
    // A file name is a writer's word too: one with a line break in it names itself on one line.
    const odd = join(thread.path, "2026-11-07T12-00-00-000Z-msg_n\nFORGED-file.md");
    writeFileSync(odd, "---\nid: msg_n\nkind: post\n---\n\nx\n");
    git(root, "add", "-A"); git(root, "commit", "-qm", "odd name");
    appendFileSync(odd, "\nedited\n"); git(root, "commit", "-qam", "edit the odd name");
    for (const args of [["check"], ["check", "decision"]]) {
      noForgedLine(await run(args, {}, false), `${args.join(" ")} (text)`);
      const data = JSON.parse(await run(args, {}, true));
      expect(data.modified.length).toBeGreaterThan(1);
      expect(JSON.stringify(data)).toContain("msg_n FORGED-file.md");
      for (const text of strings(data)) expect(text, `${args.join(" ")} (json)`).not.toMatch(/\n[ \t]*FORGED/);
    }
  });
});

describe("the display copy is only for printing", () => {
  it("--ack, --new, --since and --post match and record the ids as written, for a post whose id has a control character", async () => {
    const { root, thread } = space();
    const ctl = `msg_ctl${String.fromCharCode(1)}x`;
    writeFileSync(join(thread.path, "2026-11-07T10-04-00-000Z-msg_ctl.md"), `---\nid: ${JSON.stringify(ctl)}\ndate: 2026-11-07T10:04:00.000Z\nkind: post\nin_reply_to: msg_b\nauthor: Eve\n---\n\nControl id.\n`);
    process.chdir(root);
    const stored = () => loadThread(thread.path);
    expect(stored().posts.map((post) => post.id)).toContain(ctl);
    // Acknowledge everything: the cursor must hold the id as written.
    const acked = await run(["open", "decision"], { depth: "full", new: true, ack: true, limit: "50", reader: "walk" }, true); expect(JSON.parse(acked).acknowledged, "the ack read must succeed").toBe(true);
    expect(readCursor(stored(), "walk").has(ctl)).toBe(true);
    expect(readCursor(stored(), "walk").has("msg_ctl x")).toBe(false);
    // And so nothing is new afterwards: a cursor written from the display copy would leave this post new for ever.
    const again = JSON.parse(await run(["open", "decision"], { depth: "summary", new: true, reader: "walk" }, true));
    expect(again.matching).toBe(0);
    // --since and --post match the written id; the printed id is the one-line copy.
    const since = JSON.parse(await run(["open", "decision"], { depth: "summary", since: "msg_s", limit: "10" }, true));
    expect(since.posts.map((post: { id: string }) => post.id)).toContain("msg_ctl x");
    const one = JSON.parse(await run(["open", "decision"], { depth: "full", post: ctl }, true));
    expect(one.raw_post).toContain("Control id.");
  });
});

describe("a Thread folder name and a pinned position", () => {
  it("the protocol refuses a position the display copy would change, so matching on either slug is the same today", async () => {
    const { root } = space();
    const postFile = "2026-11-07T12-00-00-000Z-msg_o.md";
    const dir = join(root, "_threads", "odd  folder");
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), "---\nname: Odd\nsummary: Odd.\n---\n# Odd\n");
    writeFileSync(join(dir, postFile), "---\nid: msg_o\ndate: 2026-11-07T12:00:00.000Z\nkind: post\nauthor: Eve\n---\n\nIn an odd folder.\n");
    git(root, "add", "-A"); git(root, "commit", "-qm", "odd folder");
    process.chdir(root);
    const text = await run(["open", "odd  folder"], { depth: "full", pin: git(root, "rev-parse", "HEAD"), position: `_threads/odd  folder/${postFile}` }, false);
    expect(text).toContain("Invalid _threads/ Map position");
    // The handler matches the position against the folder's real name (`stored.slug`), so this stays true if the grammar ever loosens.
  });
});

describe("a malformed tags value", () => {
  it("does not crash the read of a Thread: the display copy holds a list", async () => {
    const { root } = space();
    process.chdir(root);
    const text = await run(["open", "decision"], { depth: "full" }, false);
    expect(text).not.toContain("is not a function");
    expect(text).toContain("tags: before FORGED-tags-not-a-list after");
  });
});
