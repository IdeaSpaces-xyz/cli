import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveSpace } from "../auth/spaces.js";
import { threadsCommand } from "../commands/threads.js";
import { appendPost, createThread, initWorktree, loadThread } from "../local/threads.js";

const ID = "n_0123456789abcdef01234567";
const OTHER = "n_ffffffffffffffffffffffff";
const initialCwd = process.cwd();
const initialHome = process.env.HOME;
const roots: string[] = [];
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function space(id: string) {
  const root = mkdtempSync(join(tmpdir(), "cross-thread-")); roots.push(root);
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Agreement — ${id === ID ? "Home" : "Integrator"}\nsummary: Test\nagreement: agent:repo:${id}\nroot_node_id: ${id}\n---\n`);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
  git(root, "add", "_agent/agreement.md"); git(root, "commit", "-m", "contract");
  return root;
}
function posts(root: string, slug = "decision") { return loadThread(join(root, "_threads", slug)).posts; }
function fixture(orphan = false) {
  const home = space(ID); const agent = space(OTHER);
  const own = createThread("decision", "Agent's own Thread", agent);
  appendPost(own.path, { body: "agent only" });
  const worktree = orphan ? initWorktree(home) : home;
  const thread = createThread("decision", "Home Thread", home);
  const first = appendPost(thread.path, { body: "Selected at pin", name: "Selected" });
  git(worktree, "add", orphan ? "decision" : "_threads/decision"); git(worktree, "commit", "-m", "pin");
  const pin = git(worktree, "rev-parse", "HEAD");
  const later = appendPost(thread.path, { body: "Newer live post" });
  const map = join(agent, "selection.json");
  const member = `_threads/decision/${basename(first.path)}`;
  const selection = (id = ID, sha = pin, position = member) => ({ roots: [{ root_node_id: id, sha }], members: [{ root: 0, position, depth: "full" }] });
  writeFileSync(map, JSON.stringify({ map: selection() }));
  return { home, agent, worktree, first, later, pin, map, member, selection };
}
async function run(args: string[], flags: Record<string, string | boolean> = {}) {
  let output = ""; let error = "";
  const stdout = process.stdout.write; const stderr = process.stderr.write;
  process.stdout.write = ((s: string) => { output += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { error += s; return true; }) as typeof process.stderr.write;
  try {
    const status = await threadsCommand.run(args, flags, { json: true, quiet: true, yes: false, help: false });
    return { status, data: output ? JSON.parse(output) : null, error };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
afterEach(() => {
  process.chdir(initialCwd); process.env.HOME = initialHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authored cross-Space local Thread selection", () => {
  for (const orphan of [false, true]) {
    it(`${orphan ? "orphan worktree" : "unified"}: reads only the selected pin, then branches from an older parent as the agent`, async () => {
      const f = fixture(orphan); process.env.HOME = f.agent; process.chdir(f.agent);
      saveSpace(f.home, { repo_id: "repo_test", slug: "home", namespace: "team", root_node_id: ID });
      const opened = await run(["open", "decision"], { map: f.map, member: "0", depth: "full" });
      expect(opened.status).toBe(0);
      expect(opened.data.pin).toBe(f.pin);
      expect(opened.data.position).toBe(f.member);
      expect(opened.data.pinned).toContain("Selected at pin");
      expect(opened.data.posts).toHaveLength(1);
      expect(JSON.stringify(opened.data)).not.toContain("Newer live post");
      // The packaged entrypoint must parse and forward the same selection flags.
      const installed = spawnSync(process.execPath, [join(initialCwd, "bundle", "ideaspaces.js"), "--json", "threads", "open", "decision", "--map", f.map, "--member", "0", "--depth", "full"],
        { cwd: f.agent, encoding: "utf8", env: { ...process.env, HOME: f.agent } });
      expect(installed.status, installed.stderr).toBe(0);
      expect(JSON.parse(installed.stdout).pinned).toContain("Selected at pin");
      const posted = await run(["post", "decision"], { map: f.map, member: "0", message: "Cross-Space reply", "reply-to": f.first.post.id });
      expect(posted.status).toBe(0);
      expect(posts(f.home).at(-1)?.frontmatter.author).toBe("Integrator");
      expect(posts(f.home).at(-1)?.inReplyTo).toEqual([f.first.post.id]);
      expect(posts(f.home).at(-1)?.frontmatter.map).toEqual(f.selection());
      expect(posts(f.agent)).toHaveLength(1);
      if (orphan) expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: f.worktree })).status).toBe(1);
      expect(process.cwd()).toBe(realpathSync(f.agent));
    });
  }

  it("requires a unique registered checkout or a validated explicit hint, never scans or grants by path", async () => {
    const f = fixture(); process.env.HOME = f.agent; process.chdir(f.agent);
    expect((await run(["open", "decision"], { map: f.map, member: "0" })).error).toMatch(/0 registered/);
    expect((await run(["open", f.home], { map: f.map, member: "0", checkout: f.home })).status).toBe(1);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: f.home })).status).toBe(0);
    const copy = space(ID);
    saveSpace(f.home, { repo_id: "repo_test", slug: "home", namespace: "team", root_node_id: ID });
    saveSpace(copy, { repo_id: "repo_test", slug: "copy", namespace: "team", root_node_id: ID });
    expect((await run(["open", "decision"], { map: f.map, member: "0" })).error).toMatch(/2 registered/);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: f.home })).status).toBe(0);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: f.agent })).error).toMatch(/mismatched/);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: join(f.home, "_threads") })).status).toBe(1);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: true })).status).toBe(1);
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: "../other" })).status).toBe(1);
    expect(posts(f.agent)).toHaveLength(1);
  });

  it("refuses forged root, registry/origin drift, wrong slug, absent pin and absent post without HEAD fallback", async () => {
    const f = fixture(); process.env.HOME = f.agent; process.chdir(f.agent);
    saveSpace(f.home, { repo_id: "repo_test", slug: "home", namespace: "team", root_node_id: ID });
    const check = async (value: unknown, slug = "decision") => {
      writeFileSync(f.map, JSON.stringify({ map: value }));
      expect((await run(["open", slug], { map: f.map, member: "0", depth: "full" })).status).toBe(1);
      expect((await run(["post", slug], { map: f.map, member: "0", message: "Never", "reply-to": f.first.post.id })).status).toBe(1);
      expect(posts(f.home)).toHaveLength(2); expect(posts(f.agent)).toHaveLength(1);
    };
    await check(f.selection(OTHER));
    await check(f.selection(ID, "a".repeat(40)));
    await check(f.selection(ID, f.pin, `_threads/decision/${basename(f.later.path)}`));
    await check(f.selection(ID, f.pin, f.member), "another");
    await check(f.selection(ID, f.pin, "_threads/../decision/README.md"));
    writeFileSync(f.map, JSON.stringify({ map: f.selection() }));
    git(f.home, "remote", "add", "origin", "https://git.ideaspaces.xyz/repos/n_aaaaaaaaaaaaaaaaaaaaaaaa.git");
    expect((await run(["open", "decision"], { map: f.map, member: "0" })).status).toBe(1);
    git(f.home, "remote", "remove", "origin");
    saveSpace(f.home, { repo_id: "repo_test", slug: "home", namespace: "team", root_node_id: OTHER });
    expect((await run(["open", "decision"], { map: f.map, member: "0", checkout: f.home })).status).toBe(1);
    saveSpace(f.home, { repo_id: "repo_test", slug: "home", namespace: "team", root_node_id: ID });
    writeFileSync(join(f.home, "_agent", "agreement.md"), `---\nname: Home\nsummary: Test\nroot_node_id: ${OTHER}\n---\n`);
    expect((await run(["open", "decision"], { map: f.map, member: "0" })).status).toBe(1);
  });

  it("refuses symlinks, changed or closed live targets, missing parents and implicit HEAD parent without writes", async () => {
    const f = fixture(); process.env.HOME = f.agent; process.chdir(f.agent);
    const base = { map: f.map, member: "0", checkout: f.home, message: "Never" };
    const refuse = async (extra: Record<string, string> = {}) => {
      expect((await run(["post", "decision"], { ...base, ...extra })).status).toBe(1);
      expect(posts(f.home)).toHaveLength(2);
      expect(posts(f.agent)).toHaveLength(1);
    };
    await refuse();
    await refuse({ "reply-to": "msg_missing" });
    await refuse({ "reply-to": f.later.post.id }); // only exists after the pin
    await refuse({ "reply-to": f.first.post.id, author: "Impersonator" });
    const link = join(f.agent, "alias"); symlinkSync(f.home, link);
    await refuse({ checkout: link, "reply-to": f.first.post.id });
    writeFileSync(f.first.path, readFileSync(f.first.path, "utf8") + "Changed");
    await refuse({ "reply-to": f.first.post.id });
    writeFileSync(f.first.path, readFileSync(f.first.path, "utf8").replace("Changed", ""));
    const target = join(f.home, "_threads", "decision");
    appendPost(target, { body: "End", kind: "closure" });
    expect((await run(["post", "decision"], { ...base, "reply-to": f.first.post.id })).status).toBe(1);
    expect(posts(f.home)).toHaveLength(3);
    expect(readdirSync(target).filter((name) => name.endsWith(".md"))).toHaveLength(4);
  });
});
