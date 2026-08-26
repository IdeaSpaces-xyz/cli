import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalFlags } from "../types.js";

const JSON_G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_G: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

const {
  loadConfigMock,
  findSpaceForMock,
  saveSpaceMock,
  fetchTrailLogMock,
  fetchTrailChangesMock,
  registerHelperMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  findSpaceForMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  fetchTrailLogMock: vi.fn(),
  fetchTrailChangesMock: vi.fn(),
  registerHelperMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/spaces.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/spaces.js")>();
  return { ...actual, findSpaceFor: findSpaceForMock, saveSpace: saveSpaceMock };
});
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchTrailLog: fetchTrailLogMock, fetchTrailChanges: fetchTrailChangesMock };
});
vi.mock("../auth/git-credential-helper.js", () => ({
  registerGitCredentialHelper: registerHelperMock,
}));

const { syncCommand } = await import("../commands/sync.js");

const ROOT_NODE_ID = "n_0123456789abcdef01234567";
const SOURCE_ROOT_NODE_ID = "n_fedcba9876543210fedcba98";
const SOURCE_HEAD = "a".repeat(40);
const SOURCE_NEW_HEAD = "b".repeat(40);

let tmp: string;
let cwd: string;
let clone: string;
let originHome: string | undefined;
let stdout: string;

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** An origin with one commit, and a clone of it — the ordinary shape. */
function setupCloneWithOrigin(): { origin: string; clone: string } {
  const origin = join(tmp, "origin.git");
  const seed = join(tmp, "seed");
  spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, ["config", "user.email", "t@e.com"]);
  git(seed, ["config", "user.name", "T"]);
  spawnSync("git", ["-C", seed, "commit", "-q", "--allow-empty", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);

  const dir = join(tmp, "clone");
  spawnSync("git", ["clone", "-q", origin, dir]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  return { origin, clone: dir };
}

/** Advance the origin so the clone falls behind. */
function advanceOrigin() {
  const other = join(tmp, "other");
  spawnSync("git", ["clone", "-q", join(tmp, "origin.git"), other]);
  git(other, ["config", "user.email", "t@e.com"]);
  git(other, ["config", "user.name", "T"]);
  spawnSync("git", ["-C", other, "commit", "-q", "--allow-empty", "-m", "theirs"]);
  git(other, ["push", "-q", "origin", "main"]);
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-sync-")));
  cwd = process.cwd();
  originHome = process.env.HOME;
  process.env.HOME = tmp;
  for (const m of [loadConfigMock, findSpaceForMock, saveSpaceMock, fetchTrailLogMock, fetchTrailChangesMock, registerHelperMock]) {
    m.mockReset();
  }
  loadConfigMock.mockReturnValue({ apiUrl: "https://api.test", apiKey: "k" });
  findSpaceForMock.mockReturnValue({ repo_id: "r", slug: "s", namespace: "n", root_node_id: ROOT_NODE_ID });
  fetchTrailLogMock.mockResolvedValue({
    op: "log",
    entries: [{ sha: "aaaaaaaabbbbbbbb", message: "theirs\n\nbody", date: "2026-08-10", author: "Them" }],
  });
  fetchTrailChangesMock.mockResolvedValue({
    op: "changes",
    since: "base",
    changes: [{ status: "A", path: "notes/new.md" }],
  });
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  ({ clone } = setupCloneWithOrigin());
  process.chdir(clone);
});

afterEach(async () => {
  process.chdir(cwd);
  if (originHome !== undefined) process.env.HOME = originHome;
  else delete process.env.HOME;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces sync — awareness, not integration", () => {
  it("reports the incoming commits and changed paths when behind", async () => {
    advanceOrigin();

    const exit = await syncCommand.run([], {}, JSON_G);
    expect(exit).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    expect(out.ahead).toBe(0);
    expect(out.incoming.commits[0].message).toContain("theirs");
    expect(out.incoming.changes).toEqual([{ status: "A", path: "notes/new.md" }]);
    expect(out.integrated).toBe(false);
    // Addressed by root node id — the coordinate a fork or a shared-with person
    // can use. `repo_id` would be membership-gated.
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 20);
  });

  it("reports when a fork's source moved since its recorded pin", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: SOURCE_NEW_HEAD.slice(0, 7), message: "source moved", date: "2026-08-12", author: "Them" },
        { sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" },
      ],
    });
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: SOURCE_HEAD,
      changes: [{ status: "M", path: "_agent/guide.md" }],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.source).toMatchObject({
      root_node_id: SOURCE_ROOT_NODE_ID,
      recorded_head: SOURCE_HEAD,
      current_head: SOURCE_NEW_HEAD.slice(0, 7),
      moved: true,
      commits_complete: true,
      changes: [{ status: "M", path: "_agent/guide.md" }],
      unavailable: null,
    });
    expect(out.source.commits.map((commit: { sha: string }) => commit.sha)).toEqual([
      SOURCE_NEW_HEAD.slice(0, 7),
    ]);
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), SOURCE_ROOT_NODE_ID, 100);
    expect(fetchTrailChangesMock).toHaveBeenCalledWith(expect.anything(), SOURCE_ROOT_NODE_ID, SOURCE_HEAD);
  });

  it("reports explicitly when a fork's source has not moved", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [{ sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" }],
    });
    fetchTrailChangesMock.mockResolvedValue({ op: "changes", since: SOURCE_HEAD, changes: [] });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    expect(JSON.parse(stdout).source.moved).toBe(false);

    stdout = "";
    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);
    expect(stdout).toContain(`has not moved since ${SOURCE_HEAD.slice(0, 12)}`);
  });

  it("reads source and fork-copy trails concurrently when both moved", async () => {
    advanceOrigin();
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    let releaseSourceLog!: (value: { op: string; entries: unknown[] }) => void;
    let releaseSourceChanges!: (value: { op: string; since: string; changes: unknown[] }) => void;
    const sourceLog = new Promise<{ op: string; entries: unknown[] }>((resolve) => {
      releaseSourceLog = resolve;
    });
    const sourceChanges = new Promise<{ op: string; since: string; changes: unknown[] }>((resolve) => {
      releaseSourceChanges = resolve;
    });
    fetchTrailLogMock.mockImplementation((_config, rootNodeId) =>
      rootNodeId === SOURCE_ROOT_NODE_ID
        ? sourceLog
        : Promise.resolve({
            op: "log",
            entries: [{ sha: "c".repeat(7), message: "fork copy moved", date: "2026-08-12", author: "Them" }],
          }),
    );
    fetchTrailChangesMock.mockImplementation((_config, rootNodeId, since) =>
      rootNodeId === SOURCE_ROOT_NODE_ID
        ? sourceChanges
        : Promise.resolve({ op: "changes", since, changes: [{ status: "M", path: "fork.md" }] }),
    );

    const running = syncCommand.run([], {}, JSON_G);
    await vi.waitFor(() => {
      expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 20);
      expect(fetchTrailChangesMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, expect.any(String));
    });
    releaseSourceLog({
      op: "log",
      entries: [
        { sha: SOURCE_NEW_HEAD.slice(0, 7), message: "source moved", date: "2026-08-12", author: "Them" },
        { sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" },
      ],
    });
    releaseSourceChanges({
      op: "changes",
      since: SOURCE_HEAD,
      changes: [{ status: "M", path: "source.md" }],
    });

    expect(await running).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    expect(out.source.moved).toBe(true);
  });

  it("explains when the source trail was not shared", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    const refusal = new Error(
      'GET /api/v1/spaces/n_x/git?op=log → 404: {"detail":"Space not found (no_history_relation)"}',
    );
    fetchTrailLogMock.mockRejectedValue(refusal);
    fetchTrailChangesMock.mockRejectedValue(refusal);

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    expect(stdout).toContain("Fork source:");
    expect(stdout).toContain("source Space's trail has not been shared with you");
    expect(stdout).not.toContain("recorded source Space could not be found");
  });

  it("reports source awareness on the no-upstream early-return path", async () => {
    git(clone, ["branch", "--unset-upstream"]);
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: SOURCE_NEW_HEAD.slice(0, 7), message: "source moved", date: "2026-08-12", author: "Them" },
        { sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" },
      ],
    });
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: SOURCE_HEAD,
      changes: [{ status: "M", path: "source.md" }],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.upstream).toBeNull();
    expect(out.source.moved).toBe(true);
    expect(out.source.changes).toEqual([{ status: "M", path: "source.md" }]);
  });

  it("reports an unpublished fork without fetching a nonexistent destination", async () => {
    git(clone, ["remote", "remove", "origin"]);
    loadConfigMock.mockReturnValue(null);
    findSpaceForMock.mockReturnValue({
      kind: "unpublished_fork",
      root_node_id: ROOT_NODE_ID,
      name: "Local Guide",
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
      source_baseline_initialized: true,
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out).toMatchObject({
      publication_state: "unpublished_fork",
      root_node_id: ROOT_NODE_ID,
      upstream: null,
      fetched: false,
      source: {
        root_node_id: SOURCE_ROOT_NODE_ID,
        recorded_head: SOURCE_HEAD,
      },
      integrated: false,
    });
    expect(registerHelperMock).not.toHaveBeenCalled();
    expect(fetchTrailLogMock).not.toHaveBeenCalled();
    expect(fetchTrailChangesMock).not.toHaveBeenCalled();
  });

  it("gives an expired source session its own actionable wording", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    const { UnauthorizedError } = await import("../auth/api.js");
    fetchTrailLogMock.mockRejectedValue(new UnauthorizedError("401"));
    fetchTrailChangesMock.mockRejectedValue(new UnauthorizedError("401"));

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    expect(stdout).toContain("Session expired");
    expect(stdout).toContain("to read the source Space's trail");
  });

  it("explains when the recorded source point was rewritten away", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    const rewritten = new Error("GET /api/v1/spaces/n_x/git?op=changes → 422: Git error");
    fetchTrailLogMock.mockRejectedValue(rewritten);
    fetchTrailChangesMock.mockRejectedValue(rewritten);

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    expect(stdout).toContain("recorded source point is no longer available");
    expect(stdout).toContain("may have been rewritten");
  });

  it("labels a one-sided source read as partial", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: SOURCE_NEW_HEAD.slice(0, 7), message: "source moved", date: "2026-08-12", author: "Them" },
        { sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" },
      ],
    });
    fetchTrailChangesMock.mockRejectedValue(new Error("changes timed out"));

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    expect(stdout).toContain("source moved");
    expect(stdout).toContain("Partial: Could not read the source Space's trail: changes timed out");
  });

  it("fails a deleted or stale source coordinate closed with a source-specific reason", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    const missing = new Error(
      'GET /api/v1/spaces/n_x/git?op=log → 404: {"detail":"Space not found"}',
    );
    fetchTrailLogMock.mockRejectedValue(missing);
    fetchTrailChangesMock.mockRejectedValue(missing);

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    expect(stdout).toContain("The recorded source Space could not be found");
    expect(stdout).not.toContain("ideaspaces link");
  });

  it("does not probe when a fork has no recorded source head", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.source.recorded_head).toBeNull();
    expect(out.source.unavailable).toContain("no pinned source head");
    expect(fetchTrailLogMock).not.toHaveBeenCalled();
    expect(fetchTrailChangesMock).not.toHaveBeenCalled();
  });

  it("marks the commit list incomplete when the source pin is outside the bounded window", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: Array.from({ length: 100 }, (_, index) => ({
        sha: (index + 1).toString(16).padStart(40, "0"),
        message: `source ${index + 1}`,
        date: "2026-08-12",
        author: "Them",
      })),
    });
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: SOURCE_HEAD,
      changes: [{ status: "M", path: "README.md" }],
    });

    expect(await syncCommand.run([], { limit: "2" }, TEXT_G)).toBe(0);

    expect(stdout).toContain("recorded point is not in the source's latest 100 commits");
    expect(stdout).toContain("may be older or no longer in history");
    expect(stdout).toContain("… and 98 more");
  });

  it("fails a malformed source response closed instead of throwing", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({ op: "log", entries: [{ sha: "--output=owned" }] });
    fetchTrailChangesMock.mockResolvedValue({ op: "changes", since: SOURCE_HEAD, changes: "not-a-list" });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.source.moved).toBeNull();
    expect(out.source.commits).toBeNull();
    expect(out.source.changes).toBeNull();
    expect(out.source.unavailable).toContain("invalid commit list");
    expect(out.source.unavailable).toContain("invalid changed-path list");
  });

  it("keeps a fork's files and lineage byte-identical while checking its source", async () => {
    findSpaceForMock.mockReturnValue({
      repo_id: "r",
      slug: "fork",
      namespace: "n",
      root_node_id: ROOT_NODE_ID,
      source_root_node_id: SOURCE_ROOT_NODE_ID,
      source_head: SOURCE_HEAD,
    });
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [{ sha: SOURCE_HEAD.slice(0, 7), message: "fork point", date: "2026-08-11", author: "Them" }],
    });
    fetchTrailChangesMock.mockResolvedValue({ op: "changes", since: SOURCE_HEAD, changes: [] });
    await fs.writeFile(join(clone, "untracked.md"), "# mine\n");
    const before = {
      status: git(clone, ["status", "--porcelain"]),
      head: git(clone, ["rev-parse", "HEAD"]),
      untracked: readFileSync(join(clone, "untracked.md"), "utf-8"),
    };

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    expect(git(clone, ["status", "--porcelain"])).toBe(before.status);
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(readFileSync(join(clone, "untracked.md"), "utf-8")).toBe(before.untracked);
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("leaves the working tree and git status byte-identical", async () => {
    advanceOrigin();
    await fs.writeFile(join(clone, "untracked.md"), "# mine\n");
    const before = {
      status: git(clone, ["status", "--porcelain"]),
      head: git(clone, ["rev-parse", "HEAD"]),
      files: git(clone, ["ls-files"]),
      untracked: readFileSync(join(clone, "untracked.md"), "utf-8"),
    };

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    expect(git(clone, ["status", "--porcelain"])).toBe(before.status);
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(clone, ["ls-files"])).toBe(before.files);
    expect(readFileSync(join(clone, "untracked.md"), "utf-8")).toBe(before.untracked);
    // The fetch moved the remote-tracking ref and nothing else.
    expect(git(clone, ["rev-parse", "origin/main"])).not.toBe(before.head);
  });

  it("reports what would be uploaded when ahead, without contacting the trail", async () => {
    spawnSync("git", ["-C", clone, "commit", "-q", "--allow-empty", "-m", "mine"]);

    const exit = await syncCommand.run([], {}, JSON_G);
    expect(exit).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.ahead).toBe(1);
    expect(out.behind).toBe(0);
    expect(out.outgoing.commits[0].subject).toBe("mine");
    expect(out.incoming).toBeNull();
    // Outgoing is a local question; asking the server would be a leak of
    // intent, not an answer.
    expect(fetchTrailLogMock).not.toHaveBeenCalled();
  });

  it("asks about the merge base, not local HEAD, when diverged", async () => {
    advanceOrigin();
    spawnSync("git", ["-C", clone, "commit", "-q", "--allow-empty", "-m", "mine"]);
    const localHead = git(clone, ["rev-parse", "HEAD"]);

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const since = fetchTrailChangesMock.mock.calls[0][2];
    // Local HEAD is a commit the server has never seen; the merge base is the
    // last point both sides agree on.
    expect(since).not.toBe(localHead);
    expect(since).toBe(git(clone, ["merge-base", "HEAD", "@{upstream}"]));
  });

  it("renders what a person without --json actually reads", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: "base",
      changes: [
        { status: "A", path: "notes/new.md" },
        { status: "D", path: "notes/gone.md" },
        { status: "R100", path: "notes/after.md", old_path: "notes/before.md" },
      ],
    });

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    // The rendering itself, not the payload behind it — no JSON test touches
    // describeChange or describeTrailCommit.
    expect(stdout).toContain("aaaaaaaa  theirs");
    expect(stdout).not.toContain("body"); // subject only, not the whole message
    expect(stdout).toContain("added  notes/new.md");
    expect(stdout).toContain("deleted  notes/gone.md");
    expect(stdout).toContain("renamed  notes/before.md → notes/after.md");
    expect(stdout).toContain("ideaspaces pull");
  });

  it("caps the changed-path list and says how many it held back", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: "base",
      changes: Array.from({ length: 30 }, (_, i) => ({ status: "M", path: `notes/n${i}.md` })),
    });

    expect(await syncCommand.run([], { limit: "5" }, TEXT_G)).toBe(0);

    expect(stdout).toContain("notes/n4.md");
    expect(stdout).not.toContain("notes/n5.md");
    expect(stdout).toContain("and 25 more");
  });

  it("keeps every changed path in the JSON payload even when the text is capped", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockResolvedValue({
      op: "changes",
      since: "base",
      changes: Array.from({ length: 30 }, (_, i) => ({ status: "M", path: `notes/n${i}.md` })),
    });

    expect(await syncCommand.run([], { limit: "5" }, JSON_G)).toBe(0);
    // Text is for reading and is bounded; JSON is for programs and is whole.
    expect(JSON.parse(stdout).incoming.changes).toHaveLength(30);
  });

  it("names both failures when the whole trail read comes apart", async () => {
    advanceOrigin();
    fetchTrailLogMock.mockRejectedValue(new Error("log exploded"));
    fetchTrailChangesMock.mockRejectedValue(new Error("changes exploded"));

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.incoming).toBeNull();
    expect(out.incoming_unavailable).toContain("log exploded");
  });

  it("surfaces an expired session whichever trail call carries the 401", async () => {
    const { UnauthorizedError } = await import("../auth/api.js");
    advanceOrigin();
    // The 401 lands on `changes`; `log` fails for an unrelated reason. The
    // actionable message must not depend on which call failed first.
    fetchTrailLogMock.mockRejectedValue(new Error("socket hang up"));
    fetchTrailChangesMock.mockRejectedValue(new UnauthorizedError("401"));

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    expect(JSON.parse(stdout).incoming_unavailable).toContain("ideaspaces login");
  });

  it("does not tell someone holding a clone that the Space does not exist", async () => {
    advanceOrigin();
    // What the trail endpoint actually returns for a reader without history:
    // a fail-closed 404, correct on the wire and misleading in a terminal.
    const refusal = new Error(
      'GET /api/v1/spaces/n_x/git?op=log → 404: {"detail":"Space not found (no_history_relation)"}',
    );
    fetchTrailLogMock.mockRejectedValue(refusal);
    fetchTrailChangesMock.mockRejectedValue(refusal);

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    expect(out.incoming_unavailable).toContain("trail has not been shared with you");
    expect(out.incoming_unavailable).not.toContain("404");
    expect(out.incoming_unavailable).not.toContain("Space not found");
  });

  it("explains a refusal that arrives on only one of the two calls", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockRejectedValue(
      new Error('GET /x → 404: {"detail":"Space not found (no_history_relation)"}'),
    );

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    // The commits still arrived; the note explains what is missing and why.
    expect(out.incoming.commits).toHaveLength(1);
    expect(out.incoming_unavailable).toContain("trail has not been shared with you");
  });

  it("lists only what is genuinely incoming, not the trail's recent history", async () => {
    advanceOrigin();
    // What the endpoint really returns: the Space's most recent commits. Most
    // of them are ours already — this is the live shape, where a clone one
    // commit behind was shown twenty, nineteen of them its own.
    const ours = git(clone, ["rev-parse", "HEAD"]);
    // Read from the bare origin, not the clone's remote-tracking ref: that ref
    // is still stale here, because the fetch that updates it is inside the run
    // under test. Reading it locally would hand the test its own HEAD.
    const theirs = git(join(tmp, "origin.git"), ["rev-parse", "main"]);
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: theirs, message: "theirs", date: "d", author: "Them" },
        { sha: ours, message: "seed — already ours", date: "d", author: "Us" },
      ],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    expect(out.incoming.commits).toHaveLength(1);
    expect(out.incoming.commits[0].sha).toBe(theirs);
  });

  it("shows the list whole when git cannot tell them apart", async () => {
    advanceOrigin();
    // An unknown sha makes rev-list refuse the whole question. Showing a list
    // that may include our own beats showing nothing.
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", message: "unknown", date: "d", author: "T" },
      ],
    });

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);
    expect(stdout).toContain("some may already be yours");
  });

  it("says so when the trail's window holds nothing new", async () => {
    advanceOrigin();
    const ours = git(clone, ["rev-parse", "HEAD"]);
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [{ sha: ours, message: "already ours", date: "d", author: "Us" }],
    });

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);
    // Behind, but everything the window shows is already here — the reader
    // must not read an empty list as "nothing changed".
    expect(stdout).toContain("raise --limit");
  });

  it("does not tell you to widen a window it never read", async () => {
    advanceOrigin();
    // The reachable partial failure this file's allSettled design anticipates:
    // the log call fails, the changes call succeeds.
    fetchTrailLogMock.mockRejectedValue(new Error("log 503"));

    expect(await syncCommand.run([], {}, TEXT_G)).toBe(0);

    // "raise --limit" would be wrong advice — nothing was searched.
    expect(stdout).not.toContain("raise --limit");
    expect(stdout).toContain("log 503");
  });

  it("tells a --json caller when the commit list could not be filtered", async () => {
    advanceOrigin();
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [
        { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", message: "unknown", date: "d", author: "T" },
      ],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    const out = JSON.parse(stdout);
    // A script that pulls on a non-empty list must be able to tell a trusted
    // list from the Space's recent history.
    expect(out.incoming.commits_filtered).toBe(false);
  });

  it("marks a filtered list as filtered", async () => {
    advanceOrigin();
    const theirs = git(join(tmp, "origin.git"), ["rev-parse", "main"]);
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [{ sha: theirs, message: "theirs", date: "d", author: "Them" }],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    expect(JSON.parse(stdout).incoming.commits_filtered).toBe(true);
  });

  it("rejects a malformed incoming commit before it can reach git", async () => {
    advanceOrigin();
    const bait = join(tmp, "pwned");
    // rev-list shares git's option surface, which includes --output=<file>.
    // spawnSync rules out a shell; validation also keeps this network value
    // out of git entirely.
    fetchTrailLogMock.mockResolvedValue({
      op: "log",
      entries: [{ sha: `--output=${bait}`, message: "hostile", date: "d", author: "T" }],
    });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    expect(existsSync(bait)).toBe(false);
    const out = JSON.parse(stdout);
    expect(out.incoming.commits).toEqual([]);
    expect(out.incoming_unavailable).toContain("invalid commit list");
  });

  it("rejects a malformed incoming changed-path list", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockResolvedValue({ op: "changes", since: "base", changes: "not-a-list" });

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.incoming.changes).toEqual([]);
    expect(out.incoming_unavailable).toContain("invalid changed-path list");
  });

  it("reads the trail for a clone with no record, using its canonical origin", async () => {
    advanceOrigin();
    // Bring the remote-tracking ref up to date while origin is still reachable…
    spawnSync("git", ["-C", clone, "fetch", "-q"]);
    // …then point origin at the canonical form a fork or clone would carry.
    // The fetch inside the run fails (unreachable), which is the honest state:
    // position comes from the refs we have, and the coordinate from the URL.
    // Built from the CLI's own helper so the host matches whatever the mocked
    // config derives — hardcoding it here would test the wrong deployment.
    const { canonicalGitUrl } = await import("../space-locator.js");
    git(clone, ["remote", "set-url", "origin", canonicalGitUrl("https://api.test", ROOT_NODE_ID)]);
    findSpaceForMock.mockReturnValue(null);

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    // Rung 2, through the command rather than the resolver's own tests: no
    // record, no account call, and the trail still read.
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 20);
    expect(out.incoming.commits.length).toBeGreaterThan(0);
    // Nothing to augment, so nothing written — a blank record is worse than none.
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("passes --limit through, and clamps what the endpoint would refuse", async () => {
    advanceOrigin();

    expect(await syncCommand.run([], { limit: "5" }, JSON_G)).toBe(0);
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 5);

    // The endpoint refuses 0 and caps at 100 — clamp rather than round-trip a
    // 422 the user cannot act on.
    fetchTrailLogMock.mockClear();
    expect(await syncCommand.run([], { limit: "0" }, JSON_G)).toBe(0);
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 1);

    fetchTrailLogMock.mockClear();
    expect(await syncCommand.run([], { limit: "5000" }, JSON_G)).toBe(0);
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 100);

    fetchTrailLogMock.mockClear();
    expect(await syncCommand.run([], { limit: "not-a-number" }, JSON_G)).toBe(0);
    expect(fetchTrailLogMock).toHaveBeenCalledWith(expect.anything(), ROOT_NODE_ID, 20);
  });

  it("reports a local-only ideaspace and exits 0", async () => {
    const solo = join(tmp, "solo");
    spawnSync("git", ["init", "-q", "-b", "main", solo]);
    git(solo, ["config", "user.email", "t@e.com"]);
    git(solo, ["config", "user.name", "T"]);
    spawnSync("git", ["-C", solo, "commit", "-q", "--allow-empty", "-m", "only mine"]);
    process.chdir(solo);

    const exit = await syncCommand.run([], {}, TEXT_G);
    expect(exit).toBe(0);
    expect(stdout).toContain("local only");
    expect(fetchTrailLogMock).not.toHaveBeenCalled();
  });

  it("still reports position when the trail cannot be read", async () => {
    advanceOrigin();
    loadConfigMock.mockReturnValue(null);

    const exit = await syncCommand.run([], {}, JSON_G);
    expect(exit).toBe(0);

    const out = JSON.parse(stdout);
    expect(out.behind).toBe(1);
    expect(out.incoming).toBeNull();
    expect(out.incoming_unavailable).toContain("ideaspaces login");
  });

  it("shows the commits it did get when the change list fails", async () => {
    advanceOrigin();
    fetchTrailChangesMock.mockRejectedValue(new Error("changes timed out"));

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    // Half an answer beats none: the commit list survives its sibling failing.
    expect(out.incoming.commits).toHaveLength(1);
    expect(out.incoming.changes).toEqual([]);
    expect(out.incoming_unavailable).toContain("changes timed out");
  });

  it("says so when there is no common commit to ask about", async () => {
    // Unrelated histories: the upstream shares no ancestor, so there is no
    // point to ask "what changed since". Rare, but it must not read as "nothing".
    advanceOrigin();
    spawnSync("git", ["-C", clone, "checkout", "-q", "--orphan", "detached"]);
    spawnSync("git", ["-C", clone, "commit", "-q", "--allow-empty", "-m", "unrelated"]);
    git(clone, ["branch", "-f", "main", "HEAD"]);
    spawnSync("git", ["-C", clone, "checkout", "-q", "main"]);

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);

    const out = JSON.parse(stdout);
    // Asserted, not guarded: if the setup stops producing a behind-with-no-base
    // clone, this must fail rather than pass without exercising anything.
    expect(out.behind).toBeGreaterThan(0);
    // git itself exits non-zero here — there is no common ancestor to print,
    // which is precisely the state under test.
    expect(
      spawnSync("git", ["-C", clone, "merge-base", "HEAD", "@{upstream}"], { encoding: "utf-8" })
        .status,
    ).not.toBe(0);
    expect(fetchTrailChangesMock).not.toHaveBeenCalled();
    expect(out.incoming.changes).toEqual([]);
    expect(out.incoming_unavailable).toContain("No common commit");
  });

  it("returns one schema on every exit path", async () => {
    const keysFor = async (run: () => Promise<number>) => {
      stdout = "";
      await run();
      return Object.keys(JSON.parse(stdout)).sort();
    };

    advanceOrigin();
    const behind = await keysFor(() => syncCommand.run([], {}, JSON_G));

    const solo = join(tmp, "solo2");
    spawnSync("git", ["init", "-q", "-b", "main", solo]);
    git(solo, ["config", "user.email", "t@e.com"]);
    git(solo, ["config", "user.name", "T"]);
    spawnSync("git", ["-C", solo, "commit", "-q", "--allow-empty", "-m", "only mine"]);
    process.chdir(solo);
    const localOnly = await keysFor(() => syncCommand.run([], {}, JSON_G));

    // A --json caller should not have to branch on which situation it hit.
    expect(localOnly).toEqual(behind);
    expect(localOnly).toContain("incoming_unavailable");
  });

  it("says the clone is unbound rather than guessing a coordinate", async () => {
    advanceOrigin();
    findSpaceForMock.mockReturnValue(null);

    expect(await syncCommand.run([], {}, JSON_G)).toBe(0);
    expect(JSON.parse(stdout).incoming_unavailable).toContain("ideaspaces link");
  });

  it("survives an unreachable remote and says the position is stale", async () => {
    git(clone, ["remote", "set-url", "origin", join(tmp, "gone.git")]);

    const exit = await syncCommand.run([], {}, TEXT_G);
    expect(exit).toBe(0);
    expect(stdout).toContain("last fetch");
  });
});

describe("ideaspaces sync — the integration boundary", () => {
  // The done-when asks for this as a *source* assertion, not a behavioral one:
  // an edit that adds a merge would pass every test above until someone
  // happened to write the case that catches it. An allowlist fails closed —
  // a new import has to be justified here before it can compile in.
  const READ_ONLY_GIT_HELPERS = [
    "repoRoot",
    "fetch as gitFetch",
    "remoteState",
    "mergeBaseWithUpstream",
    "commitsAheadOfUpstream",
    "pathsAheadOfUpstream",
    "commitsNotInHistory",
  ];

  function syncSource(): string {
    return readFileSync(new URL("../commands/sync.ts", import.meta.url), "utf-8");
  }

  it("takes only read-only helpers from git.ts, through exactly one import", () => {
    const source = syncSource();

    // Every route from this file into git.ts, not just the first one. A second
    // `import { mergeUpstream } from "../git.js"` is legal TypeScript and no
    // lint rule here forbids it, so counting is part of the assertion.
    const routes = [...source.matchAll(/from\s*"\.\.\/git\.js"/g)];
    expect(routes).toHaveLength(1);

    // …and that one route must be a named import. `import * as git` would put
    // the whole module in reach while satisfying every check below.
    expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*"\.\.\/git\.js"/);

    const statements = [...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\.\/git\.js"/g)];
    expect(statements).toHaveLength(1);

    const imported = statements
      .flatMap((match) => match[1].split(","))
      .map((s) => s.trim())
      .filter(Boolean);

    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) expect(READ_ONLY_GIT_HELPERS).toContain(name);
    // Named explicitly so this fails if git.ts ever grows an integrating verb
    // and someone reaches for it here.
    for (const forbidden of ["rebaseOntoUpstream", "mergeUpstream", "push", "stagePaths", "commitPaths"]) {
      expect(imported).not.toContain(forbidden);
    }
  });

  it("catches a second import statement sneaking an integrating verb in", () => {
    // Proves the assertion above actually bites — the bug it replaces passed
    // this exact shape. Mirrors the real check against a doctored source.
    const doctored =
      'import { repoRoot } from "../git.js";\nimport { mergeUpstream } from "../git.js";\n';
    const routes = [...doctored.matchAll(/from\s*"\.\.\/git\.js"/g)];
    expect(routes).toHaveLength(2);

    const firstOnly = doctored.match(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\.\/git\.js"/)?.[1];
    // The old single-match read saw only `repoRoot` and passed.
    expect(firstOnly?.trim()).toBe("repoRoot");
  });

  it("cannot run git itself, and cannot write to the tree", () => {
    const code = syncSource().replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // No private channel to git that bypasses the allowlist above…
    expect(code).not.toMatch(/child_process|spawnSync|execFile|execSync/);
    // …and no filesystem writes of any kind.
    expect(code).not.toMatch(/writeFile|writeFileSync|mkdir|rm\(|unlink|appendFile/);
  });
});
