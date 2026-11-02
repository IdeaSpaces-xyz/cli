import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("a hand-written saved search with no roots searches the Note's own folder", async () => {
    write(join(vault, "notes", "mine.search.md"), "---\nname: Mine\nsearch:\n  query: loopback\n---\n");
    const opened = await run([], { open: "notes/mine.search.md" });
    expect(opened.exit).toBe(0);
    expect(opened.json.roots.map((r: { root: string }) => r.root)).toEqual([join(vault, "notes")]);
  });
});
