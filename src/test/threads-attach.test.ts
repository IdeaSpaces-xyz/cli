import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachThread, loadThread, resolveThreadParent } from "../local/threads.js";
import { threadsCommand } from "../commands/threads.js";

// One Space, four Threads: two possible parents, a child started under parent-a,
// and a grandchild started under the child. All names and ids are synthetic.
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const A = "msg_parent_a_opening";
const B = "msg_parent_b_opening";
const CHILD = "msg_child_opening";
const CHILD_REPLY = "msg_child_reply";
const GRAND = "msg_grandchild_opening";
const CHILD_AGREEMENT = "---\nname: Agreement — Child\nsummary: Child terms in one line.\n---\n# Child\n\nCHILD_TERMS_SENTINEL\n";

function post(dir: string, file: string, id: string, extra = "", body = "Body.") {
  writeFileSync(join(dir, file), `---\nid: ${id}\ndate: 2026-10-26T13:50:00.000Z\nkind: post\nauthor: Fixture\nname: ${id}\n${extra}---\n\n${body}\n`);
}

function thread(root: string, slug: string, agreement: string | null): string {
  const dir = join(root, "_threads", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `---\nname: ${slug}\nsummary: ${slug} lens\n---\n\n# ${slug}\n`);
  if (agreement !== null) {
    mkdirSync(join(dir, "_agent"));
    writeFileSync(join(dir, "_agent", "agreement.md"), agreement);
  }
  return dir;
}

function space() {
  const root = mkdtempSync(join(tmpdir(), "is-attach-")); temp.push(root);
  process.env.HOME = root;
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Fixture Space\nsummary: Space terms in one line.\n---\n# Space\n\nSPACE_TERMS_SENTINEL\n");
  const a = thread(root, "parent-a", "---\nname: Agreement — A\nsummary: A terms.\n---\n# A\n");
  post(a, "01-open.md", A);
  const b = thread(root, "parent-b", "---\nname: Agreement — B\nsummary: B terms.\n---\n# B\n");
  post(b, "01-open.md", B);
  const child = thread(root, "child", CHILD_AGREEMENT);
  post(child, "01-open.md", CHILD, `attached_to: post:${A}\n`);
  post(child, "02-reply.md", CHILD_REPLY, `in_reply_to: ${CHILD}\n`);
  const grand = thread(root, "grandchild", "---\nname: Agreement — Grandchild\nsummary: G terms.\n---\n# G\n");
  post(grand, "01-open.md", GRAND, `attached_to: post:${CHILD}\n`);
  return { root, a, b, child, grand };
}

async function run(args: string[], options: Record<string, string | boolean>, cwd: string, json = true) {
  const previous = process.cwd(); process.chdir(cwd);
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  let out = ""; let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run(args, options, { json, quiet: true, yes: false, help: false });
    return { code, out, err };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous); }
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return files;
}

describe("threads open carries the Thread's reference frame", () => {
  it("gives one post read the Thread's and Space's Agreements at summary", async () => {
    const { root, child } = space();
    const opened = await run(["open", child], { post: CHILD_REPLY }, root);
    expect(opened.code).toBe(0);
    const json = JSON.parse(opened.out);
    expect(json.schema).toBe("ideaspaces.local-thread.open.v4");
    expect(json.reference.contractRole).toBe("reference");
    expect(json.reference.contract.filter((entry: { name: string }) => entry.name === "agreement")
      .map((entry: { representation: string }) => entry.representation)).toEqual(["summary", "summary"]);
    expect(opened.out).not.toContain("CHILD_TERMS_SENTINEL");

    const text = await run(["open", child], { post: CHILD_REPLY }, root, false);
    expect(text.out.startsWith("Focus:")).toBe(true);
    expect(text.out).toContain("Child terms in one line.");
    expect(text.out).toContain("summary only — read _threads/child/_agent/agreement.md in full before writing here");
    expect(text.out).toContain(`id: ${CHILD_REPLY}`);
  });

  it("loads the Thread's own Agreement in full on request; the Space's stays summary", async () => {
    const { root, child } = space();
    const text = await run(["open", child], { post: CHILD_REPLY, agreement: "full" }, root, false);
    expect(text.code).toBe(0);
    expect(text.out).toContain("CHILD_TERMS_SENTINEL");
    expect(text.out).not.toContain("SPACE_TERMS_SENTINEL");
    expect(text.out).toContain("Space terms in one line.");
  });

  it("refuses a bad --agreement value and --agreement on a pinned read", async () => {
    const { root, child } = space();
    const bad = await run(["open", child], { agreement: "body" }, root);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--agreement must be `summary` or `full`");
    const pinned = await run(["open", child], { agreement: "full", pin: "0".repeat(40), position: "_threads/child/01-open.md" }, root);
    expect(pinned.code).toBe(1);
    expect(pinned.err).toContain("a pinned read carries none");
  });
});

describe("threads attach", () => {
  it("moves a Thread: Agreement attached_to, one reframe, origin kept", async () => {
    const { root, b, child } = space();
    const agreementBefore = readFileSync(join(child, "_agent", "agreement.md"), "utf8");
    const attached = await run(["attach", child, `post:${B}`], { message: "The work now belongs under B.", author: "Tester" }, root);
    expect(attached.err).toBe("");
    expect(attached.code).toBe(0);
    const json = JSON.parse(attached.out);
    expect(json.previous_parent.id).toBe(A);
    expect(json.parent).toMatchObject({ id: B, slug: "parent-b", attached_to: B });
    expect(json.origin).toBe(`post:${A}`);
    expect(json.agreement_created).toBe(false);

    // Only attached_to is added; every other byte of the Agreement is kept.
    const agreementAfter = readFileSync(join(child, "_agent", "agreement.md"), "utf8");
    expect(agreementAfter).toBe(agreementBefore.replace("summary: Child terms in one line.\n", `summary: Child terms in one line.\nattached_to: ${B}\n`));

    const loaded = loadThread(child);
    const reframe = loaded.allPosts.find((p) => p.id === json.reframe.id)!;
    expect(reframe.kind).toBe("reframe");
    expect(reframe.inReplyTo).toEqual([CHILD_REPLY]);
    expect(reframe.body).toContain(`Previous parent: ${A} (parent-a)`);
    expect(reframe.body).toContain(`New parent: ${B}`);
    expect(reframe.body).toContain(`Origin, unchanged: post:${A}`);
    expect(reframe.body).toContain("Why: The work now belongs under B.");
    expect(readFileSync(join(child, "01-open.md"), "utf8")).toContain(`attached_to: post:${A}`);

    const parent = resolveThreadParent(child);
    expect(parent).toMatchObject({ id: B, slug: "parent-b", origin: `post:${A}` });
    const opened = await run(["open", child], { depth: "summary" }, root, false);
    expect(opened.out).toContain(`Parent post: ${B} (parent-b)`);
    expect(opened.out).toContain(`Origin: post:${A}`);
    const underB = JSON.parse((await run(["open", b], { post: B }, root)).out);
    expect(underB.child_threads.map((c: { slug: string }) => c.slug)).toEqual(["child"]);
  });

  it("writes the minimal Agreement for a Thread that has none, and says so", async () => {
    const { root } = space();
    const bare = thread(root, "bare", null);
    post(bare, "01-open.md", "msg_bare_opening", `attached_to: post:${A}\n`);
    const attached = await run(["attach", bare, B], { message: "Moving.", author: "Tester" }, root, false);
    expect(attached.code).toBe(0);
    expect(attached.out).toContain("created: this Thread had none");
    expect(readFileSync(join(bare, "_agent", "agreement.md"), "utf8")).toContain(`attached_to: ${B}\n`);
    expect(resolveThreadParent(bare)?.id).toBe(B);
  });

  const refusals: Array<[string, (f: ReturnType<typeof space>) => [string[], Record<string, string>], RegExp]> = [
    ["a non-post link", (f) => [["attach", f.child, "note:@space//notes/topic.md"], { message: "x", author: "T" }], /takes a post target; note:@space\/\/notes\/topic\.md is a note link/],
    ["an unresolved post", (f) => [["attach", f.child, "msg_missing_post"], { message: "x", author: "T" }], /not a readable post in this Space/],
    ["a post in the Thread itself", (f) => [["attach", f.child, CHILD_REPLY], { message: "x", author: "T" }], /cannot be its own parent/],
    ["a post in a descendant Thread", (f) => [["attach", f.child, GRAND], { message: "x", author: "T" }], /would make a cycle/],
    ["the parent it already has", (f) => [["attach", f.child, `post:${A}`], { message: "x", author: "T" }], /already attached/],
    ["a hosted Thread", (f) => [["attach", "x_0123456789abcdef01234567", B], { message: "x", author: "T" }], /local Threads only/],
    ["no reason", (f) => [["attach", f.child, B], { author: "T" }], /--message is required/],
  ];
  for (const [label, make, message] of refusals) {
    it(`refuses ${label} and changes nothing`, async () => {
      const fixture = space();
      const before = snapshot(fixture.root);
      const [args, flags] = make(fixture);
      const refused = await run(args, flags, fixture.root);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(message);
      expect(snapshot(fixture.root)).toEqual(before);
    });
  }

  it("refuses a Thread whose opening post is unreadable", async () => {
    const { root } = space();
    const broken = thread(root, "broken", "---\nname: Agreement — Broken\nsummary: B.\n---\n");
    writeFileSync(join(broken, "01-open.md"), "---\nid: [\n---\nBroken\n");
    const before = snapshot(root);
    const refused = await run(["attach", broken, B], { message: "x", author: "T" }, root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("unreadable; writes refused");
    expect(snapshot(root)).toEqual(before);
  });

  it("restores the Agreement when the reframe cannot be written", async () => {
    const fixture = space();
    const before = snapshot(fixture.root);
    const refused = await run(["attach", fixture.child, B], { message: "x", author: "Two\nlines" }, fixture.root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("the Agreement was restored and the Thread did not move");
    expect(snapshot(fixture.root)).toEqual(before);
    expect(existsSync(join(fixture.child, "_agent", "agreement.md"))).toBe(true);
  });
});

describe("threads attach keeps every other Agreement byte", () => {
  async function attachWith(agreement: string) {
    const fixture = space();
    writeFileSync(join(fixture.child, "_agent", "agreement.md"), agreement);
    const result = await run(["attach", fixture.child, B], { message: "Moving.", author: "Tester" }, fixture.root);
    return { result, after: () => readFileSync(join(fixture.child, "_agent", "agreement.md"), "utf8") };
  }

  it("replaces an existing one-line attached_to in place", async () => {
    const before = `---\nname: Agreement — Child\nattached_to: ${A}\nsummary: S.\n---\n# Child\n`;
    const { result, after } = await attachWith(before);
    expect(result.code).toBe(0);
    expect(after()).toBe(before.replace(`attached_to: ${A}\n`, `attached_to: ${B}\n`));
  });

  it("keeps CRLF line endings, including on the line it adds", async () => {
    const before = "---\r\nname: Agreement — Child\r\nsummary: S.\r\n---\r\n# Child\r\n";
    const { result, after } = await attachWith(before);
    expect(result.code).toBe(0);
    expect(after()).toBe(`---\r\nname: Agreement — Child\r\nsummary: S.\r\nattached_to: ${B}\r\n---\r\n# Child\r\n`);
  });

  it("adds frontmatter to a plain-Markdown Agreement and keeps its body", async () => {
    const { result, after } = await attachWith("# Child\n\nPlain terms.\n");
    expect(result.code).toBe(0);
    expect(after()).toBe(`---\nattached_to: ${B}\n---\n# Child\n\nPlain terms.\n`);
  });

  it("refuses a multi-line attached_to and changes nothing", async () => {
    const fixture = space();
    writeFileSync(join(fixture.child, "_agent", "agreement.md"), `---\nname: Agreement — Child\nattached_to: >\n  ${A}\n---\n# Child\n`);
    const before = snapshot(fixture.root);
    const refused = await run(["attach", fixture.child, B], { message: "Moving.", author: "Tester" }, fixture.root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("spans several lines");
    expect(snapshot(fixture.root)).toEqual(before);
  });
});

describe("threads open when the reference frame cannot be selected", () => {
  it("logs the diagnostic and keeps --json stdout one valid object", async () => {
    const { root, child } = space();
    writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Agreement — Fixture Space\ncontext:\n  full: [../outside.md]\n---\n# Space\n");
    const opened = await run(["open", child], { depth: "summary" }, root);
    expect(opened.code).toBe(0);
    const json = JSON.parse(opened.out);
    expect(json.reference).toBeUndefined();
    expect(json.reference_diagnostic).toContain("invalid_full_load_path");
    expect(json.thread.path).toBe(loadThread(child).path);
  });
});

describe("--agreement on look and navigate", () => {
  async function command(which: "look" | "navigate", args: string[], flags: Record<string, string | boolean>, cwd: string) {
    const { lookCommand } = await import("../commands/look.js");
    const { navigateCommand } = await import("../commands/navigate.js");
    const previous = process.cwd(); process.chdir(cwd);
    const stdout = process.stdout.write; const stderr = process.stderr.write;
    let out = ""; let err = "";
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try {
      const code = await (which === "look" ? lookCommand : navigateCommand).run(args, flags, { json: false, quiet: true, yes: false, help: false });
      return { code, out, err };
    } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous); }
  }

  it("look and navigate --focus load the target's own Agreement in full on request", async () => {
    const { root, child } = space();
    const looked = await command("look", [join(child, "02-reply.md")], { agreement: "full" }, root);
    expect(looked.code).toBe(0);
    expect(looked.out).toContain("CHILD_TERMS_SENTINEL");
    expect(looked.out).not.toContain("SPACE_TERMS_SENTINEL");
    const summary = await command("look", [join(child, "02-reply.md")], {}, root);
    expect(summary.out).not.toContain("CHILD_TERMS_SENTINEL");
    const focused = await command("navigate", [child], { focus: true, agreement: "full" }, root);
    expect(focused.code).toBe(0);
    expect(focused.out).toContain("CHILD_TERMS_SENTINEL");
  });

  it("navigate refuses --agreement without --focus or an address", async () => {
    const { root } = space();
    const refused = await command("navigate", [root], { agreement: "full" }, root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("use it with --focus or an address");
  });
});

describe("threads attach after the Agreement is written", () => {
  const failingPost = () => { throw new Error("INJECTED_POST_FAILURE"); };
  const realWrite = (path: string, content: string) => writeFileSync(path, content);

  it("restores the Agreement when appendPost fails after the write", () => {
    const fixture = space();
    const before = snapshot(fixture.root);
    let writes = 0;
    expect(() => attachThread(fixture.child, B, { message: "Moving.", author: "Tester" }, {
      appendPost: failingPost as never,
      writeAgreement: (path, content) => { writes++; realWrite(path, content); },
    })).toThrow(/could not be written, so the Agreement was restored and the Thread did not move: INJECTED_POST_FAILURE/);
    expect(writes).toBe(2); // the move, then the restore
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it("names both failures, the file and the parent it now says when the restore fails too", () => {
    const fixture = space();
    const agreementPath = join(fixture.child, "_agent", "agreement.md");
    let writes = 0;
    let message = "";
    try {
      attachThread(fixture.child, B, { message: "Moving.", author: "Tester" }, {
        appendPost: failingPost as never,
        writeAgreement: (path, content) => {
          if (++writes === 2) throw new Error("INJECTED_RESTORE_FAILURE");
          realWrite(path, content);
        },
      });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("INJECTED_POST_FAILURE");
    expect(message).toContain("INJECTED_RESTORE_FAILURE");
    expect(message).toContain(agreementPath);
    expect(message).toContain(`attached_to now says ${B}, with no reframe post`);
    expect(readFileSync(agreementPath, "utf8")).toContain(`attached_to: ${B}`);
    expect(loadThread(fixture.child).allPosts).toHaveLength(2);
  });

  it("refuses a --message of shell-escaped newlines before writing", async () => {
    const fixture = space();
    const before = snapshot(fixture.root);
    const refused = await run(["attach", fixture.child, B], { message: "first\\nsecond\\nthird", author: "Tester" }, fixture.root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("repeated literal \\n sequences");
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it("names the Threads its cycle check could not follow", async () => {
    const fixture = space();
    const broken = thread(fixture.root, "broken", "---\nname: Agreement — Broken\nsummary: B.\n---\n");
    writeFileSync(join(broken, "01-open.md"), "---\nid: [\n---\nBroken\n");
    const attached = await run(["attach", fixture.child, B], { message: "Moving.", author: "Tester" }, fixture.root);
    expect(attached.code).toBe(0);
    expect(JSON.parse(attached.out).cycle_check_skipped).toEqual(["broken"]);
    const clean = space();
    const quiet = await run(["attach", clean.child, B], { message: "Moving.", author: "Tester" }, clean.root);
    expect(JSON.parse(quiet.out).cycle_check_skipped).toEqual([]);
  });
});

it("attaches an existing x_-prefixed local folder without treating it as hosted", async () => {
  const f = space();
  const renamed = join(f.root, "_threads", "x_notes"); renameSync(f.child, renamed);
  const result = await run(["attach", "x_notes", `post:${B}`], { message: "Move local Thread", author: "Fixture" }, f.root);
  expect(result.code, result.err).toBe(0);
  expect(resolveThreadParent(renamed)?.id).toBe(B);
});
