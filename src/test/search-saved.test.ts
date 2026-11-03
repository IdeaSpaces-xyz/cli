import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@ideaspaces/protocol";
import { loadConfig } from "../auth/credentials.js";
import { searchCommand } from "../commands/search.js";
import { readSavedSearch, SavedSearchError } from "../search-saved.js";
import { captureJson } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

vi.mock("../auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/credentials.js")>()),
  loadConfig: vi.fn(() => null),
}));

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let vault: string;
let originalCwd: string;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function run(args: string[], flags: Record<string, unknown>) {
  return captureJson(() => searchCommand.run(args, flags as Record<string, string | boolean>, G));
}

async function runErr(args: string[], flags: Record<string, unknown>) {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const exit = await searchCommand.run(args, flags as Record<string, string | boolean>, { ...G, json: false });
    return { exit, stderr: writes.join("") };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

const strip = (data: { results: Array<Record<string, unknown>> }) =>
  data.results.map(({ path, root, score, snippet, line, kind, title }) => ({ path, root, score, snippet, line, kind, title }));

beforeEach(async () => {
  vault = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-search-saved-")));
  originalCwd = process.cwd();
  process.chdir(vault);
  vi.mocked(loadConfig).mockReturnValue(null);
  git(vault, ["init", "-q", "-b", "main"]);
  write(join(vault, ".gitignore"), "agents/\n");
  write(join(vault, "_agent", "agreement.md"), "---\nname: Home\n---\n");
  write(join(vault, "notes", "plan.md"), "---\nname: The plan\ntags: [desktop]\n---\nThe loopback page.\n");
  write(join(vault, "_threads", "t", "README.md"), "---\nname: T\n---\n");
  write(join(vault, "_threads", "t", "2026-11-02T10-00-00-000Z-msg_a.md"), "---\nid: msg_a\nauthor: Scout\ntags: [friction]\n---\nloopback friction\n");
  const scout = join(vault, "agents", "scout");
  mkdirSync(scout, { recursive: true });
  git(scout, ["init", "-q", "-b", "main"]);
  write(join(scout, "memory", "loop.md"), "# Loop\n\nloopback again\n");
  mkdirSync(join(vault, "searches"), { recursive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(vault, { recursive: true, force: true });
});

describe("saved searches", () => {
  it("saves a search as a Note and opens it again to the same results", async () => {
    const roots = [vault, join(vault, "agents", "scout")];
    const first = await run(["loopback"], {
      root: roots, threads: true, save: "searches/loop.search.md", name: "Loopback", summary: "Where the loopback is.",
    });
    expect(first.exit).toBe(0);
    const notePath = join(vault, "searches", "loop.search.md");
    expect(first.json.saved).toMatchObject({ path: notePath, name: "Loopback", search: { query: "loopback", roots: ["..", "../agents/scout"], threads: true } });

    const note = readFileSync(notePath, "utf8");
    expect(parseFrontmatter(note)).toEqual({
      name: "Loopback", summary: "Where the loopback is.",
      search: { query: "loopback", roots: ["..", "../agents/scout"], threads: true },
    });
    expect(note).not.toContain(vault);
    expect(note).toContain("ideaspaces search --open");

    const again = await run([], { open: "searches/loop.search.md" });
    expect(again.exit).toBe(0);
    expect(strip(again.json)).toEqual(strip(first.json));
    expect(again.json.saved).toMatchObject({ path: notePath, name: "Loopback" });
  });

  it("opens from any directory, resolving roots from the Note's own folder", async () => {
    await run(["loopback tag:friction"], { root: [vault], threads: true, save: "searches/f.search.md" });
    process.chdir(join(vault, "agents", "scout"));
    const opened = await run([], { open: join(vault, "searches", "f.search.md") });
    expect(opened.exit).toBe(0);
    expect(opened.json.results.map((r: { path: string }) => r.path)).toEqual(["_threads/t/2026-11-02T10-00-00-000Z-msg_a.md"]);
    expect(opened.json.saved.name).toBe("Search: loopback tag:friction");
  });

  it("saves the current repository when no --root is given, and keeps an explicit --limit", async () => {
    const saved = await run(["loopback"], { save: "searches/here.search.md", limit: "5" });
    expect(saved.exit).toBe(0);
    expect(saved.json.saved.search).toEqual({ query: "loopback", roots: [".."], threads: false, limit: 5 });
    const opened = await run([], { open: "searches/here.search.md" });
    expect(opened.json.roots.map((r: { root: string }) => r.root)).toEqual([vault]);
  });

  it("refuses to replace an existing Note without --force", async () => {
    await run(["loopback"], { root: [vault], save: "searches/x.search.md" });
    const again = await runErr(["plan"], { root: [vault], save: "searches/x.search.md" });
    expect(again.exit).toBe(1);
    expect(again.stderr).toContain("already exists");
    const forced = await run(["plan"], { root: [vault], save: "searches/x.search.md", force: true });
    expect(forced.exit).toBe(0);
    expect(readSavedSearch(join(vault, "searches", "x.search.md")).search.query).toBe("plan");
  });

  it("refuses a path that is not a Note, and --open mixed with a new query", async () => {
    const notMd = await runErr(["loopback"], { root: [vault], save: "searches/x.txt" });
    expect(notMd.stderr).toContain("ending in .md");
    const mixed = await runErr(["other"], { open: "searches/x.search.md" });
    expect(mixed.exit).toBe(1);
    expect(mixed.stderr).toContain("--open runs the Note's own query");
    const stray = await runErr(["loopback"], { root: [vault], name: "No save" });
    expect(stray.stderr).toContain("go with --save");
  });

  it("names what is wrong with a Note that is not a saved search", async () => {
    write(join(vault, "searches", "plain.md"), "---\nname: Plain\n---\nBody\n");
    write(join(vault, "searches", "bad.md"), "---\nsearch:\n  query: ''\n---\n");
    write(join(vault, "searches", "roots.md"), "---\nsearch:\n  query: x\n  roots: notalist\n---\n");
    expect(() => readSavedSearch(join(vault, "searches", "plain.md"))).toThrow(/no search: block/);
    expect(() => readSavedSearch(join(vault, "searches", "bad.md"))).toThrow(/search.query/);
    expect(() => readSavedSearch(join(vault, "searches", "roots.md"))).toThrow(/search.roots/);
    expect(() => readSavedSearch(join(vault, "searches", "missing.md"))).toThrow(SavedSearchError);
    const opened = await runErr([], { open: "searches/plain.md" });
    expect(opened.exit).toBe(1);
    expect(opened.stderr).toContain("no search: block");
  });

  it("--force replaces a saved search but never an ordinary Note", async () => {
    const plan = readFileSync(join(vault, "notes", "plan.md"), "utf8");
    const refused = await runErr(["loopback"], { root: [vault], save: "notes/plan.md", force: true });
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("not a saved search; --force only replaces saved searches");
    expect(readFileSync(join(vault, "notes", "plan.md"), "utf8")).toBe(plan);
  });

  it("refuses a missing folder, a search outside a repository with no --root, and keeps one-line titles", async () => {
    const missing = await runErr(["loopback"], { root: [vault], save: "nowhere/x.search.md" });
    expect(missing.exit).toBe(1);
    expect(missing.stderr).toContain("No such folder for the saved search");
    const outside = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-search-saved-outside-")));
    try {
      process.chdir(outside);
      const noRepo = await runErr(["loopback"], { save: "x.search.md" });
      expect(noRepo.exit).toBe(1);
      expect(noRepo.stderr).toContain("to save a search");
    } finally {
      process.chdir(vault);
      await rm(outside, { recursive: true, force: true });
    }
    const titled = await run(["loopback"], { root: [vault], save: "searches/t.search.md", name: "Two\nlines   here" });
    expect(titled.json.saved.name).toBe("Two lines here");
    expect(readFileSync(join(vault, "searches", "t.search.md"), "utf8")).toContain("# Two lines here\n");
  });

  it("names a bad threads or limit value, and lets --limit override the stored one", async () => {
    write(join(vault, "searches", "threads.md"), "---\nsearch:\n  query: x\n  threads: yes please\n---\n");
    write(join(vault, "searches", "zero.md"), "---\nsearch:\n  query: x\n  limit: 0\n---\n");
    write(join(vault, "searches", "text.md"), "---\nsearch:\n  query: x\n  limit: \"5\"\n---\n");
    expect(() => readSavedSearch(join(vault, "searches", "threads.md"))).toThrow(/search.threads/);
    expect(() => readSavedSearch(join(vault, "searches", "zero.md"))).toThrow(/search.limit/);
    expect(() => readSavedSearch(join(vault, "searches", "text.md"))).toThrow(/search.limit/);
    write(join(vault, "searches", "one.search.md"), "---\nsearch:\n  query: loopback\n  roots: [\"..\", ../agents/scout]\n  limit: 1\n---\n");
    const stored = await run([], { open: "searches/one.search.md" });
    expect(stored.json.total).toBe(1);
    const overridden = await run([], { open: "searches/one.search.md", limit: "5" });
    expect(overridden.json.total).toBe(2);
  });

  it("says where it looked when a saved root is gone", async () => {
    write(join(vault, "searches", "gone.search.md"), "---\nsearch:\n  query: loopback\n  roots: [../gone]\n---\n");
    const { exit, json } = await run([], { open: "searches/gone.search.md" });
    expect(exit).toBe(1);
    expect(json.roots[0].root).toBe(join(vault, "gone"));
    const human = await runErr([], { open: "searches/gone.search.md" });
    expect(human.stderr).toContain(join(vault, "gone"));
    expect(human.stderr).toContain("relative to its Note");
  });

  it("an --open with other flags gives one clear refusal", async () => {
    const mixed = await runErr([], { open: "searches/x.search.md", name: "Foo" });
    expect(mixed.exit).toBe(1);
    expect(mixed.stderr).toContain("takes no --name");
  });

  it.skipIf(process.platform === "win32")("never finds its own Note, even when opened through a symlinked folder", async () => {
    write(join(vault, "searches", "self.search.md"), "---\nname: Self\nsearch:\n  query: loopback\n  roots: [\"..\"]\n---\nloopback loopback loopback\n");
    symlinkSync(join(vault, "searches"), join(vault, "linked"));
    const opened = await run([], { open: "linked/self.search.md" });
    expect(opened.exit).toBe(0);
    expect(opened.json.results.map((r: { path: string }) => r.path)).not.toContain("searches/self.search.md");
  });

  it("writes no working-directory path into the Note, and quotes the path it prints", async () => {
    mkdirSync(join(vault, "deep", "er"), { recursive: true });
    process.chdir(join(vault, "deep", "er"));
    const saved = await run(["loopback"], { root: [vault], save: "../../searches/my loop.search.md" });
    expect(saved.exit).toBe(0);
    const note = readFileSync(join(vault, "searches", "my loop.search.md"), "utf8");
    expect(note).not.toContain("../../searches");
    expect(note).toContain("ideaspaces search --open 'my loop.search.md'");
    const human = await runErr(["plan"], { root: [vault], save: "../../searches/other one.search.md" });
    expect(human.exit).toBe(0);
  });

  it("answers --save in the --root form, so a script sees one shape", async () => {
    const plain = await run(["loopback"], {});
    expect(plain.json.map_status).toBeDefined();
    const saved = await run(["loopback"], { save: "searches/shape.search.md" });
    expect(saved.json.roots).toEqual([expect.objectContaining({ root: vault })]);
    expect(saved.json.map_status).toBeUndefined();
    expect(saved.json.results[0].root).toBe(vault);
  });

  it("--force replaces a large saved search, and names a target it cannot check", async () => {
    write(join(vault, "searches", "big.search.md"), `---\nname: Big\nsearch:\n  query: loopback\n---\n${"x".repeat(70 * 1024)}\n`);
    const replaced = await run(["plan"], { root: [vault], save: "searches/big.search.md", force: true });
    expect(replaced.exit).toBe(0);
    expect(readSavedSearch(join(vault, "searches", "big.search.md")).search.query).toBe("plan");
    mkdirSync(join(vault, "searches", "dir.md"));
    const folder = await runErr(["plan"], { root: [vault], save: "searches/dir.md", force: true });
    expect(folder.exit).toBe(1);
    expect(folder.stderr).toContain("is not a file");
  });

  it.skipIf(process.platform === "win32")("stores roots relative to the Note's real folder, even when saved through a symlink", async () => {
    symlinkSync(join(vault, "searches"), join(vault, "via"));
    const saved = await run(["loopback"], { root: [vault], save: "via/s.search.md" });
    expect(saved.json.saved.search.roots).toEqual([".."]);
  });

  it("a hand-written saved search with no roots searches the Note's own folder", async () => {
    write(join(vault, "notes", "mine.search.md"), "---\nname: Mine\nsearch:\n  query: loopback\n---\n");
    const opened = await run([], { open: "notes/mine.search.md" });
    expect(opened.exit).toBe(0);
    expect(opened.json.roots.map((r: { root: string }) => r.root)).toEqual([join(vault, "notes")]);
  });
});
