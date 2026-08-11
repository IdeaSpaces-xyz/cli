import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { fetchAuthMeMock } = vi.hoisted(() => ({ fetchAuthMeMock: vi.fn() }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});

const CONFIG = { apiUrl: "https://api.example.test", apiKey: "k" };
const ROOT = "n_0123456789abcdef01234567";

let tmp: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

function repoWithOrigin(name: string, origin: string): string {
  const dir = join(tmp, name);
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  spawnSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return realpathSync(dir);
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-resolve-")));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  // Logged-out resolution falls back to the default deployment; pin it here
  // rather than at module scope, so it cannot leak into another test file.
  originalApiUrl = process.env.IS_API_URL;
  process.env.IS_API_URL = "https://api.example.test";
  fetchAuthMeMock.mockReset();
  vi.resetModules();
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalApiUrl !== undefined) process.env.IS_API_URL = originalApiUrl;
  else delete process.env.IS_API_URL;
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveSpaceBinding", () => {
  it("takes the registry record when it has one, without touching the network", async () => {
    const { saveSpace } = await import("../auth/spaces.js");
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("bound", "https://git.example.test/alice/notes.git");
    saveSpace(dir, { repo_id: "r", slug: "notes", namespace: "alice", root_node_id: ROOT });

    expect(await resolveSpaceBinding(dir, CONFIG)).toEqual({ rootNodeId: ROOT, via: "record" });
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
  });

  it("reads the coordinate out of a canonical origin, with no record and no account", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("forked", `https://git.example.test/spaces/${ROOT}.git`);

    // No config at all — this is the rung a Grant-only reader arrives on, and
    // they never appear in auth/me because that list is membership-shaped.
    expect(await resolveSpaceBinding(dir, null)).toEqual({ rootNodeId: ROOT, via: "origin" });
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
  });

  it("heals the registry so the cost is paid once per clone", async () => {
    const { saveSpace, findSpaceFor } = await import("../auth/spaces.js");
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("legacy-record", `https://git.example.test/spaces/${ROOT}.git`);
    // The shape found on a real machine: no root_node_id at all.
    saveSpace(dir, { repo_id: "repo_old", slug: "notes", namespace: "alice" });

    await resolveSpaceBinding(dir, CONFIG);

    const healed = findSpaceFor(dir);
    expect(healed?.root_node_id).toBe(ROOT);
    // Additive — what the record already carried survives.
    expect(healed?.repo_id).toBe("repo_old");
    expect(healed?.slug).toBe("notes");
  });

  it("refuses a wrong-host canonical URL even with no session", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("elsewhere-anon", `https://git.evil.test/spaces/${ROOT}.git`);

    // Logged out is the normal first call for a Grant-only reader. If the check
    // only ran when a session happened to exist, this would be accepted.
    expect(await resolveSpaceBinding(dir, null)).toBeNull();
  });

  it("does not heal a clone it has no record for", async () => {
    const { findSpaceFor } = await import("../auth/spaces.js");
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("fresh-fork", `https://git.example.test/spaces/${ROOT}.git`);

    expect(await resolveSpaceBinding(dir, null)).toEqual({ rootNodeId: ROOT, via: "origin" });
    // A record written here would carry blank repo_id/slug/namespace, which
    // publish reads directly and would report as a broken mapping. Rung 2 is
    // free to repeat, so no record is better than half a record.
    expect(findSpaceFor(dir)).toBeNull();
  });

  it("refuses a canonical URL on a different deployment", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("elsewhere", `https://git.evil.test/spaces/${ROOT}.git`);
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });

    // A node id addressed at the wrong host is not this Space.
    expect(await resolveSpaceBinding(dir, CONFIG)).toBeNull();
  });

  it("matches a legacy origin against the account and records what it learned", async () => {
    const { findSpaceFor } = await import("../auth/spaces.js");
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("legacy", "https://git.example.test/alice/notes.git");
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        {
          repo_id: "repo_notes",
          slug: "notes",
          hostname: null,
          root_node_id: ROOT,
          role: "OWNER",
          member_count: 1,
        },
      ],
    });

    expect(await resolveSpaceBinding(dir, CONFIG)).toEqual({ rootNodeId: ROOT, via: "account" });
    expect(findSpaceFor(dir)?.root_node_id).toBe(ROOT);
  });

  it("declines to guess when the origin matches more than one Space", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("ambiguous", "https://git.example.test/alice/notes.git");
    const repo = {
      repo_id: "repo_a",
      slug: "notes",
      hostname: null,
      root_node_id: ROOT,
      role: "OWNER",
      member_count: 1,
    };
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [repo, { ...repo, repo_id: "repo_b" }],
    });

    // `ideaspaces link <dir> <space>` exists to be told; guessing would bind
    // the clone to the wrong Space silently.
    expect(await resolveSpaceBinding(dir, CONFIG)).toBeNull();
  });

  it("returns null rather than throwing when the account cannot be reached", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = repoWithOrigin("offline", "https://git.example.test/alice/notes.git");
    fetchAuthMeMock.mockRejectedValue(new Error("network down"));

    expect(await resolveSpaceBinding(dir, CONFIG)).toBeNull();
  });

  it("gives up on a clone with no origin at all", async () => {
    const { resolveSpaceBinding } = await import("../auth/resolve-space.js");
    const dir = join(tmp, "no-remote");
    spawnSync("git", ["init", "-q", "-b", "main", dir]);

    expect(await resolveSpaceBinding(realpathSync(dir), CONFIG)).toBeNull();
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
  });
});
