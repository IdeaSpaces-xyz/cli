import { describe, it, expect } from "vitest";
import { deriveCatalog } from "../commands/catalog.js";
import type { CloneEntry, RepoStatus } from "../commands/catalog.js";
import type { AuthMeRepo } from "../auth/api.js";

const repo = (over: Partial<AuthMeRepo>): AuthMeRepo => ({
  repo_id: "r",
  slug: "s",
  hostname: null,
  role: "owner",
  member_count: 1,
  ...over,
});

const clone = (path: string, repo_id: string, over: Partial<CloneEntry["record"]> = {}): CloneEntry => ({
  path,
  record: { repo_id, slug: repo_id, namespace: "alice", ...over },
});

const unpublished = (path = "/w/guide"): CloneEntry => ({
  path,
  record: {
    kind: "unpublished_fork",
    root_node_id: "n_0123456789abcdef01234567",
    name: "Local Guide",
    source_root_node_id: "n_ffffffffffffffffffffffff",
    source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
    source_baseline_initialized: true,
  },
});

const synced: RepoStatus = { branch: "main", ahead: 0, behind: 0, dirty: false };
const behind: RepoStatus = { branch: "main", ahead: 0, behind: 2, dirty: false };

describe("deriveCatalog — logged in", () => {
  const me = {
    username: "alice",
    repos: [
      repo({ repo_id: "r1", slug: "notes" }),
      repo({ repo_id: "r2", slug: "team", hostname: "acme.com", role: "member", member_count: 4 }),
    ],
  };

  it("tags cloned/uncloned/orphan by location and carries sync + identity", () => {
    const clones = [clone("/w/notes", "r1"), clone("/w/scratch", "rX")]; // r1 cloned; rX orphan
    const status = new Map<string, RepoStatus>([
      ["/w/notes", behind],
      ["/w/scratch", synced],
    ]);

    const entries = deriveCatalog(me, clones, status);
    const by = Object.fromEntries(entries.map((e) => [e.slug, e]));

    // r1 is cloned → available, with sync + the clone path
    expect(by.notes).toMatchObject({
      location: "available",
      clone: { path: "/w/notes" },
      sync: { behind: 2 },
      namespace: "alice",
    });
    // r2 has no clone → online-only (pullable), org namespace, no sync
    expect(by.team).toMatchObject({ location: "online-only", namespace: "acme.com" });
    expect(by.team.sync).toBeUndefined();
    expect(by.team.clone).toBeUndefined();
    // rX is on disk but not in the account → local-only
    expect(by.rX).toMatchObject({ location: "local-only", clone: { path: "/w/scratch" } });
  });

  it("projects receipt actions and stable fallbacks for a slugless root", () => {
    const receiptOnly = repo({
      repo_id: "repo_shared",
      slug: null,
      name: "Shared Guide",
      role: null,
      receipt_classes: ["direct_person"],
      actions: ["copy"],
    });

    const entry = deriveCatalog({ username: "alice", repos: [receiptOnly] }, [], new Map())[0];

    expect(entry).toMatchObject({
      repo_id: "repo_shared",
      slug: "repo_shared",
      display_name: "Shared Guide",
      relationship: "shared",
      receipt_classes: ["direct_person"],
      actions: ["copy"],
      location: "online-only",
    });
  });

  it("emits one available entry per clone when a repo is cloned twice", () => {
    const clones = [clone("/a/notes", "r1"), clone("/b/notes", "r1")];
    const status = new Map<string, RepoStatus>([
      ["/a/notes", synced],
      ["/b/notes", behind],
    ]);
    const entries = deriveCatalog(me, clones, status);
    const notes = entries.filter((e) => e.slug === "notes");
    expect(notes).toHaveLength(2);
    expect(notes.map((e) => e.location)).toEqual(["available", "available"]);
    expect(notes.map((e) => e.clone?.path).sort()).toEqual(["/a/notes", "/b/notes"]);
  });

  it("marks statusFailed when git state couldn't be read", () => {
    const clones = [clone("/w/notes", "r1")];
    const status = new Map<string, RepoStatus>([["/w/notes", { failed: true }]]);
    const entry = deriveCatalog(me, clones, status).find((e) => e.slug === "notes");
    expect(entry).toMatchObject({ location: "available", statusFailed: true });
    expect(entry?.sync).toBeUndefined();
  });

  it("does not join an unpublished fork to a hosted destination", () => {
    const entry = deriveCatalog(me, [unpublished()], new Map()).find(
      (candidate) => candidate.state === "unpublished_fork",
    )!;
    expect(entry).toMatchObject({
      state: "unpublished_fork",
      repo_id: null,
      root_node_id: "n_0123456789abcdef01234567",
      display_name: "Local Guide",
      location: "local-only",
      clone: { path: "/w/guide" },
      source_root_node_id: "n_ffffffffffffffffffffffff",
    });
    expect(entry.slug).toBeNull();
    expect(entry.namespace).toBe("");
  });
});

describe("deriveCatalog — logged out", () => {
  it("reports hosted clones as available without a server list to cross-ref", () => {
    const clones = [clone("/w/notes", "r1"), clone("/w/scratch", "rX")];
    const status = new Map<string, RepoStatus>([
      ["/w/notes", synced],
      ["/w/scratch", behind],
    ]);
    const entries = deriveCatalog(null, clones, status);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.location === "available")).toBe(true);
    expect(entries.find((e) => e.slug === "rX")?.sync).toMatchObject({ behind: 2 });
  });

  it("shows an unpublished fork distinctly while logged out", () => {
    const entry = deriveCatalog(null, [unpublished()], new Map())[0];
    expect(entry).toMatchObject({
      state: "unpublished_fork",
      repo_id: null,
      display_name: "Local Guide",
      location: "local-only",
    });
  });

  it("returns nothing when there are no clones", () => {
    expect(deriveCatalog(null, [], new Map())).toEqual([]);
  });
});
