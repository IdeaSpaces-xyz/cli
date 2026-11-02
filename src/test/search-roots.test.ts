import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../auth/credentials.js";
import { parseArgs } from "../argv.js";
import { searchCommand } from "../commands/search.js";
import { searchDocs } from "../search.js";
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

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

async function run(args: string[], flags: Record<string, unknown>) {
  return captureJson(() => searchCommand.run(args, flags as Record<string, string | boolean>, G));
}

async function search(query: string, roots: string[], extra: Record<string, unknown> = {}) {
  const { exit, json } = await run([query], { root: roots, ...extra });
  expect(exit).toBe(0);
  return json;
}

beforeEach(async () => {
  vault = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-search-roots-")));
  originalCwd = process.cwd();
  process.chdir(vault);
  vi.mocked(loadConfig).mockReturnValue(null);

  // Home: a Space with a Thread, ignoring its child repos.
  repo(vault);
  write(join(vault, ".gitignore"), "agents/\ncode/\n");
  write(join(vault, "_agent", "agreement.md"), "---\nname: Agreement — Home\n---\n# Home\n");
  write(join(vault, "notes", "plan.md"), "---\nname: The plan\ntags: [Onboarding, desktop]\n---\n# Plan\n\nThe loopback page returns.\n");
  write(join(vault, "_threads", "onboard", "README.md"), "---\nname: Onboarding\nsummary: Getting in.\n---\n# Onboarding\n");
  write(join(vault, "_threads", "onboard", "2026-11-02T10-00-00-000Z-msg_a.md"),
    "---\nid: msg_aaaaaaaa-0000-4000-8000-000000000001\ndate: 2026-11-02T10:00:00.000Z\nkind: post\nauthor: Scout\nname: Scout on the loopback\ntags:\n  - friction\n---\n\nThe loopback page is served by the app.\n");

  // An agent repo, a sibling corpus.
  const agent = repo(join(vault, "agents", "scout"));
  write(join(agent, "_agent", "agreement.md"), "---\nname: Agreement — Scout\n---\n# Scout\n");
  write(join(agent, "memory", "pēteris.md"), "# Pēteris\n\nPēteris wrote the loopback note.\n");

  // A code checkout with no Agreement: --threads must not read Home's Threads from here.
  const code = repo(join(vault, "code", "app"));
  write(join(code, "README.md"), "# App\n\nNothing about it.\n");
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(vault, { recursive: true, force: true });
});

describe("search --root: one corpus across several roots", () => {
  it("ranks every root against shared corpus statistics", async () => {
    const data = await search("loopback", [vault, join(vault, "agents", "scout")]);
    // The same three documents scored as one corpus give the same order and scores.
    const expected = searchDocs([
      { path: "notes/plan.md", content: "---\nname: The plan\ntags: [Onboarding, desktop]\n---\n# Plan\n\nThe loopback page returns.\n" },
      { path: "_agent/agreement.md", content: "---\nname: Agreement — Home\n---\n# Home\n" },
      { path: "_agent/agreement.md#scout", content: "---\nname: Agreement — Scout\n---\n# Scout\n" },
      { path: "memory/pēteris.md", content: "# Pēteris\n\nPēteris wrote the loopback note.\n" },
    ], "loopback");
    expect(data.scanned).toBe(4);
    expect(data.results.map((r: { score: number }) => r.score).sort()).toEqual(expected.map((r) => r.score).sort());
    expect(data.complete).toBe(true);
    expect(data.base).toBe(vault);
    expect(data.roots).toEqual([
      { root: vault, listing: "git", listed: 2, scanned: 2 },
      { root: join(vault, "agents", "scout"), listing: "git", listed: 2, scanned: 2 },
    ]);
  });

  it("describes each hit: root, kind, title, summary, tags, updated, and the Thread it belongs to", async () => {
    const when = new Date("2026-11-01T12:00:00.000Z");
    utimesSync(join(vault, "notes", "plan.md"), when, when);
    const data = await search("loopback", [vault], { threads: true });
    const plan = data.results.find((r: { path: string }) => r.path === "notes/plan.md");
    expect(plan).toMatchObject({
      root: vault, kind: "note", title: "The plan", summary: null, tags: ["onboarding", "desktop"],
      snippet: "The loopback page returns.", line: 7, updated: when.toISOString(),
    });
    expect(plan.thread).toBeUndefined();
    const post = data.results.find((r: { kind: string }) => r.kind === "thread_post");
    expect(post).toMatchObject({
      title: "Scout on the loopback", tags: ["friction"],
      thread: { slug: "onboard", post_id: "msg_aaaaaaaa-0000-4000-8000-000000000001", author: "Scout", date: "2026-11-02T10:00:00.000Z" },
    });
  });

  it("finds a Unicode word folded either way, and its top hit contains it", async () => {
    for (const query of ["Pēteris", "peteris", "PĒTERIS"]) {
      const data = await search(query, [vault, join(vault, "agents", "scout")]);
      expect(data.results[0].path).toBe("memory/pēteris.md");
      expect(data.results[0].snippet).toContain("Pēteris");
    }
  });

  it("reads only a root's own Threads: a nested repo never reads its parent Space's", async () => {
    const nested = await search("loopback", [join(vault, "code", "app")], { threads: true });
    expect(nested.scanned).toBe(1);
    expect(nested.total).toBe(0);
    const home = await search("loopback", [vault], { threads: true });
    expect(home.results.map((r: { kind: string }) => r.kind).sort()).toEqual(["note", "thread_post"]);
  });

  it("leaves Threads out unless asked, and kind:thread asks", async () => {
    const plain = await search("loopback", [vault]);
    expect(plain.results.map((r: { path: string }) => r.path)).toEqual(["notes/plan.md"]);
    const threads = await search("onboarding kind:thread", [vault]);
    expect(threads.results.map((r: { kind: string }) => r.kind)).toEqual(["thread_readme"]);
    expect(threads.results[0]).toMatchObject({ title: "Onboarding", summary: "Getting in.", thread: { slug: "onboard", post_id: null } });
  });

  it("walks a plain folder that is not a Git repo, skipping noise and nested repos", async () => {
    const plain = `${vault}-plain`;
    try {
      write(join(plain, "a", "loopback.md"), "# A\n");
      write(join(plain, "node_modules", "pkg", "loopback.md"), "# no\n");
      write(join(plain, ".hidden", "loopback.md"), "# no\n");
      repo(join(plain, "inner"));
      write(join(plain, "inner", "loopback.md"), "# no\n");
      const data = await search("loopback", [plain]);
      expect(data.roots[0]).toMatchObject({ listing: "walk", scanned: 1 });
      expect(data.results.map((r: { path: string }) => r.path)).toEqual(["a/loopback.md"]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("answers from the roots that work and names the one that does not", async () => {
    const data = await search("loopback", [vault, join(vault, "missing")]);
    expect(data.complete).toBe(false);
    expect(data.roots[1]).toEqual({ root: join(vault, "missing"), listed: 0, scanned: 0, error: `No such folder: ${join(vault, "missing")}` });
    expect(data.total).toBe(1);
  });

  it("fails with every reason when no root can be searched, and JSON still carries the roots", async () => {
    const { exit, json } = await run(["loopback"], { root: [join(vault, "nope")] });
    expect(exit).toBe(1);
    expect(json).toMatchObject({ complete: false, total: 0, results: [], roots: [{ root: join(vault, "nope"), error: `No such folder: ${join(vault, "nope")}` }] });
    const { exit: humanExit, stderr } = await captureStdoutAndErr(["loopback"], { root: [join(vault, "nope")] });
    expect(humanExit).toBe(1);
    expect(stderr).toContain("Check each path exists");
  });

  it("counts files read, not files listed: a tracked file deleted from disk is not scanned", async () => {
    git(vault, ["add", "notes/plan.md"]);
    write(join(vault, "notes", "gone.md"), "loopback\n");
    git(vault, ["add", "notes/gone.md"]);
    await rm(join(vault, "notes", "gone.md"));
    const data = await search("loopback", [vault]);
    expect(data.roots[0]).toMatchObject({ listed: 3, scanned: 2 });
    expect(data.scanned).toBe(2);
  });

  it("counts a file reachable from two roots once, for the deeper root", async () => {
    const plain = `${vault}-overlap`;
    try {
      write(join(plain, "loopback.md"), "# top\n");
      write(join(plain, "sub", "loopback.md"), "# sub\n");
      const data = await search("loopback", [plain, join(plain, "sub")]);
      expect(data.scanned).toBe(2);
      expect(data.roots.map((r: { scanned: number }) => r.scanned)).toEqual([1, 1]);
      expect(data.results.find((r: { root: string }) => r.root === join(plain, "sub")).path).toBe("loopback.md");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not list a symlinked _threads folder", async () => {
    const elsewhere = `${vault}-elsewhere`;
    try {
      write(join(elsewhere, "t", "README.md"), "---\nname: Elsewhere\n---\nloopback\n");
      const space = repo(join(vault, "agents", "linked"));
      write(join(space, "_agent", "agreement.md"), "---\nname: Linked\n---\n");
      symlinkSync(elsewhere, join(space, "_threads"));
      const data = await search("loopback", [space], { threads: true });
      expect(data.total).toBe(0);
      expect(data.roots[0].warnings).toEqual(["_threads is a symlink; its Threads were not searched"]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("query filters through the command", () => {
  it("a tag filter narrows the hits", async () => {
    const all = await search("loopback", [vault, join(vault, "agents", "scout")], { threads: true });
    expect(all.total).toBe(3);
    const tagged = await search("loopback tag:friction", [vault, join(vault, "agents", "scout")], { threads: true });
    expect(tagged.results.map((r: { kind: string }) => r.kind)).toEqual(["thread_post"]);
    const either = await search("loopback tag:friction,onboarding", [vault], { threads: true });
    expect(either.total).toBe(2);
  });

  it("a tag word that appears only in another frontmatter field does not match", async () => {
    write(join(vault, "notes", "decoy.md"), "---\nname: Decoy\nsummary: About friction, not tagged so.\ntags: [other]\n---\nloopback\n");
    const data = await search("loopback tag:friction", [vault], { threads: true });
    expect(data.results.map((r: { path: string }) => r.path)).not.toContain("notes/decoy.md");
    expect(data.total).toBe(1);
  });

  it("a query of only filters lists every match, newest first", async () => {
    utimesSync(join(vault, "notes", "plan.md"), new Date("2026-01-01"), new Date("2026-01-01"));
    const data = await search("tag:friction,desktop", [vault], { threads: true });
    expect(data.results.map((r: { path: string }) => r.path)).toEqual([
      "_threads/onboard/2026-11-02T10-00-00-000Z-msg_a.md",
      "notes/plan.md",
    ]);
    expect(data.results.every((r: { score: number }) => r.score === 0)).toBe(true);
  });

  it("in: chooses folders from the search base or the file's own root", async () => {
    const roots = [vault, join(vault, "agents", "scout")];
    const fromBase = await search("loopback in:agents/scout", roots);
    expect(fromBase.results.map((r: { path: string }) => r.path)).toEqual(["memory/pēteris.md"]);
    const fromRoot = await search("loopback in:memory", roots);
    expect(fromRoot.results.map((r: { path: string }) => r.path)).toEqual(["memory/pēteris.md"]);
    const excluded = await search("loopback -in:agents", roots);
    expect(excluded.results.map((r: { path: string }) => r.path)).toEqual(["notes/plan.md"]);
  });

  it("author: and -word narrow, and a bad filter is refused with what to write", async () => {
    const byScout = await search("loopback author:scout", [vault], { threads: true });
    expect(byScout.results.map((r: { kind: string }) => r.kind)).toEqual(["thread_post"]);
    const without = await search("loopback -served", [vault], { threads: true });
    expect(without.results.map((r: { path: string }) => r.path)).toEqual(["notes/plan.md"]);
    const { exit, stderr } = await captureStdoutAndErr(["loopback kind:image"], { root: [vault] });
    expect(exit).toBe(1);
    expect(stderr).toContain("Use one of: note, thread, post, readme");
  });
});

describe("single-repo search keeps its shape", () => {
  it("adds the hit description without the multi-root fields", async () => {
    git(vault, ["add", "."]);
    const { exit, json } = await run(["loopback"], {});
    expect(exit).toBe(0);
    expect(json.root.local_path).toBe(vault);
    expect(json.roots).toBeUndefined();
    expect(json.results[0]).toMatchObject({ path: "notes/plan.md", kind: "note", title: "The plan" });
    expect(json.results[0].root).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reads Home's own Threads with --threads and an unreadable file only degrades", async () => {
    const unreadable = join(vault, "notes", "locked.md");
    write(unreadable, "loopback");
    chmodSync(unreadable, 0o000);
    try {
      const { exit, json } = await run(["loopback"], { threads: true });
      expect(exit).toBe(0);
      expect(json.results.map((r: { kind: string }) => r.kind).sort()).toEqual(["note", "thread_post"]);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});

describe("argv", () => {
  it("collects repeated --root for search only", () => {
    expect(parseArgs(["search", "--root", "a", "--root=b", "--threads", "q"]).flags).toEqual({ root: ["a", "b"], threads: true });
    expect(parseArgs(["map", "add", "x", "--root", "0", "--root", "1"]).flags).toEqual({ root: "1" });
  });
});

async function captureStdoutAndErr(args: string[], flags: Record<string, unknown>) {
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
