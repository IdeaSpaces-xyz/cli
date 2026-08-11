import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalFlags } from "../types.js";

const JSON_G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_G: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

const { loadConfigMock, findSpaceForMock, fetchTrailLogMock, fetchTrailChangesMock, registerHelperMock } =
  vi.hoisted(() => ({
    loadConfigMock: vi.fn(),
    findSpaceForMock: vi.fn(),
    fetchTrailLogMock: vi.fn(),
    fetchTrailChangesMock: vi.fn(),
    registerHelperMock: vi.fn(),
  }));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/spaces.js", () => ({ findSpaceFor: findSpaceForMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchTrailLog: fetchTrailLogMock, fetchTrailChanges: fetchTrailChangesMock };
});
vi.mock("../auth/git-credential-helper.js", () => ({
  registerGitCredentialHelper: registerHelperMock,
}));

const { syncCommand } = await import("../commands/sync.js");

const ROOT_NODE_ID = "n_0123456789abcdef01234567";

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
  for (const m of [loadConfigMock, findSpaceForMock, fetchTrailLogMock, fetchTrailChangesMock, registerHelperMock]) {
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
