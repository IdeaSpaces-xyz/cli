import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadsCommand } from "../commands/threads.js";
import { appendPost, createThread } from "../local/threads.js";

const temp: string[] = [];
const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  vi.unstubAllEnvs();
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function space() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "is-owner-"))); temp.push(root);
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent/agreement.md"), "---\nname: Agreement — Test\nsummary: Test\n---\n# Test\n");
  process.env.HOME = root;
  if (process.platform === "win32") vi.stubEnv("USERPROFILE", root);
  return root;
}

async function list(root: string, flags: Record<string, string | boolean> = {}) {
  const previous = process.cwd(); process.chdir(root);
  let out = "";
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof stdout;
  process.stderr.write = ((s: string) => { return true; }) as typeof stderr;
  try {
    await threadsCommand.run(["list", root], flags, { json: true, quiet: true, yes: false, help: false });
    return JSON.parse(out).threads as Array<Record<string, any>>;
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(previous); }
}

describe("threads list carries attached_to, an owner and post dates", () => {
  it("returns the three fields for an attached subthread, a README holder and a Thread with no holder", async () => {
    const root = space();
    const parent = createThread("parent", "Parent", root);
    const opening = appendPost(parent.path, { body: "Open", author: "Alice" });
    const child = createThread("child", "Child", root);
    appendPost(child.path, { body: "Child open", author: "Bob", attachedTo: `post:${opening.post.id}` });
    appendPost(child.path, { body: "Child reply", author: "Bob" });
    const held = createThread("held", "Held", root);
    appendPost(held.path, { body: "Open", author: "Dana" });
    writeFileSync(join(held.path, "README.md"), '---\nname: Held\nsummary: "Open. A room. Held by Carol, from Steward."\n---\n\n# Held\n');
    const plain = createThread("plain", "Plain", root);
    appendPost(plain.path, { body: "Open", author: "Dana" });
    const empty = createThread("empty", "Empty", root);

    const rows = Object.fromEntries((await list(root)).map((row) => [row.slug, row]));
    expect(rows.child).toMatchObject({ attached_to: `post:${opening.post.id}`, owner: "Bob", owner_source: "opening_post" });
    expect(rows.parent).toMatchObject({ attached_to: null, owner: "Alice" });
    expect(rows.held).toMatchObject({ owner: "Carol", owner_source: "readme" });
    expect(rows.plain).toMatchObject({ owner: "Dana", owner_source: "opening_post" });
    expect(rows.empty).toMatchObject({ owner: null, first_post_at: null, newest_post_at: null });
    for (const slug of ["parent", "child", "held", "plain"]) {
      expect(Date.parse(rows[slug].first_post_at)).not.toBeNaN();
      expect(Date.parse(rows[slug].newest_post_at)).toBeGreaterThanOrEqual(Date.parse(rows[slug].first_post_at));
    }
    expect(rows.child.newest_post_at).toBe(rows.child.latest_activity_at);
    // the name rung carries them too
    const names = Object.fromEntries((await list(root, { depth: "name" })).map((row) => [row.slug, row]));
    expect(names.held).toMatchObject({ owner: "Carol", attached_to: null });
    expect(names.child.attached_to).toBe(`post:${opening.post.id}`);
  });

  it("reads owner: and Holder: from the README before the opening author", async () => {
    const root = space();
    const a = createThread("a", "A", root); appendPost(a.path, { body: "x", author: "Dana" });
    writeFileSync(join(a.path, "README.md"), "---\nname: A\nsummary: A\nowner: Erin\n---\n\n# A\n");
    const b = createThread("b", "B", root); appendPost(b.path, { body: "x", author: "Dana" });
    writeFileSync(join(b.path, "README.md"), "---\nname: B\nsummary: B\n---\n\n# B\n\nHolder: **Frank** (the human, 2026-10-19)\n");
    const rows = Object.fromEntries((await list(root)).map((row) => [row.slug, row]));
    expect(rows.a.owner).toBe("Erin");
    expect(rows.b.owner).toBe("Frank");
  });
});
