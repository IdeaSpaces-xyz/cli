import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listEntries, filterEntries, type FileEntry } from "../file-listing.js";

// A workspace fixture: a non-git parent containing plain folders, a code repo,
// an ideaspace repo, noise dirs, and a dot-dir — the real shape ls walks.
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ls-test-"));
  const mk = (rel: string) => mkdirSync(join(root, rel), { recursive: true });
  const wr = (rel: string, body = "x") => writeFileSync(join(root, rel), body);

  wr("README.md");
  mk("notes");
  wr("notes/awareness.md");
  mk("notes/deep");
  wr("notes/deep/buried.md");

  mk("code-lib/.git"); // a code repo
  wr("code-lib/index.ts");

  mk("space-x/_agent"); // an ideaspace repo (also would be git, but _agent wins)
  mkdirSync(join(root, "space-x", ".git"), { recursive: true });
  wr("space-x/_agent/now.md");
  wr("space-x/purpose.md");

  mk("node_modules/pkg"); // noise — excluded
  wr("node_modules/pkg/junk.js");
  mk(".hidden"); // dot-dir — excluded
  wr(".hidden/secret.md");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const byPath = (entries: FileEntry[]) => new Map(entries.map((e) => [e.path, e]));

describe("listEntries", () => {
  it("lists files and folders, typing repos by their marker", () => {
    const { entries } = listEntries(root);
    const m = byPath(entries);
    expect(m.get("README.md")?.kind).toBe("file");
    expect(m.get("notes")?.kind).toBe("folder");
    expect(m.get("notes/awareness.md")?.kind).toBe("file");
    expect(m.get("code-lib")?.kind).toBe("code-repo");
    // _agent wins over .git — an ideaspace repo reads as ideaspace, not plain code.
    expect(m.get("space-x")?.kind).toBe("ideaspace-repo");
  });

  it("excludes noise dirs and dot-entries, and recurses into repos", () => {
    const paths = listEntries(root).entries.map((e) => e.path);
    expect(paths).toContain("notes/deep/buried.md"); // nested plain folder
    expect(paths).toContain("space-x/purpose.md"); // recurses into the ideaspace repo
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".hidden"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  it("honours the depth cap and reports truncation on the scan cap", () => {
    // depth 0 = root's direct children only; deep files are not reached.
    const shallow = listEntries(root, { maxDepth: 0 });
    expect(shallow.entries.map((e) => e.path)).not.toContain("notes/deep/buried.md");
    expect(shallow.entries.map((e) => e.path)).toContain("notes");

    const capped = listEntries(root, { maxScan: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.entries.length).toBe(2);
  });
});

describe("filterEntries", () => {
  const entries = (): FileEntry[] => [
    { path: "notes/awareness.md", name: "awareness.md", kind: "file" },
    { path: "other/passing-awareness-note.md", name: "passing-awareness-note.md", kind: "file" },
    { path: "misc.md", name: "misc.md", kind: "file" },
  ];

  it("ranks a name match above a path/substring match", () => {
    const r = filterEntries(entries(), "awareness", 10);
    expect(r[0].path).toBe("notes/awareness.md"); // name starts with query
    expect(r.map((e) => e.path)).not.toContain("misc.md"); // no match dropped
  });

  it("returns the head unfiltered for an empty query, honouring the limit", () => {
    const r = filterEntries(entries(), "  ", 2);
    expect(r).toHaveLength(2);
    expect(r[0].path).toBe("notes/awareness.md");
  });
});
