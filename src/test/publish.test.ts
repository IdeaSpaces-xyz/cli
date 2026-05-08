import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalFlags } from "../types.js";

const baseGlobal: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};

let tmp: string;
let originalCwd: string;
let originalHome: string | undefined;

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-publish-"));
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  process.chdir(tmp);
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  await rm(tmp, { recursive: true, force: true });
});

function writeCredentials() {
  const dir = join(tmp, ".ideaspaces");
  mkdirSync(dir, { recursive: true });
  return writeFile(
    join(dir, "credentials.json"),
    JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
  );
}

function md(nodeId = "n_abcdef123456abcdef123456", body = "# foo"): string {
  return `---\nname: Foo\nnode_id: ${nodeId}\n---\n\n${body}\n`;
}

function initLocalRepo(name = "my-space", opts: { withNodeId?: boolean } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", dir, "config", "user.email", "local@example.com"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "Local"]);
  writeFileSync(join(dir, "foo.md"), opts.withNodeId === false ? "# foo\n" : md());
  spawnSync("git", ["-C", dir, "add", "."]);
  spawnSync("git", ["-C", dir, "commit", "-q", "-m", "first"]);
  return dir;
}

function authMeResponse(username = "ernests_s"): Response {
  return new Response(
    JSON.stringify({
      user_id: 1,
      username,
      email: null,
      name: null,
      repos: [],
      onboarding_complete: true,
    }),
    { status: 200 },
  );
}

function setupBareRemote(namespace: string, slug: string): string {
  const root = join(tmp, "bare-root");
  const target = join(root, namespace, `${slug}.git`);
  mkdirSync(join(root, namespace), { recursive: true });
  spawnSync("git", ["init", "--bare", "-q", "-b", "main", target]);
  process.env.IS_GIT_URL = `file://${root}`;
  return target;
}

describe("ideaspaces publish", () => {
  it("errors when not in a git repo", async () => {
    await writeCredentials();
    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
  });

  it("errors when not logged in", async () => {
    const dir = initLocalRepo();
    process.chdir(dir);
    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
  });

  it("preflights markdown node_id before publishing", async () => {
    const dir = initLocalRepo("missing-id", { withNodeId: false });
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, ".ideaspaces", "spaces.json"))).toBe(false);
  });

  it("ignores untracked markdown during publish preflight", async () => {
    const dir = initLocalRepo("untracked-ok");
    process.chdir(dir);
    writeFileSync(join(dir, "scratch.md"), "# local scratch without node id\n");
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_untracked", slug: "untracked-ok", name: "untracked-ok" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupBareRemote("ernests_s", "untracked-ok");

    const { publishCommand } = await import("../commands/publish.js");
    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
  });

  it("calls /auth/me and /repos, sets local user.email, adds origin, pushes", async () => {
    const dir = initLocalRepo("my-space");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_abc", slug: "my-space", name: "my-space" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setupBareRemote("ernests_s", "my-space");

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const cfgEmail = spawnSync("git", ["-C", dir, "config", "--local", "user.email"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(cfgEmail).toBe("person:ernests_s@ideaspaces");

    const origin = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(origin).toContain("/ernests_s/my-space.git");

    expect(existsSync(join(tmp, ".ideaspaces", "spaces.json"))).toBe(true);
    const map = JSON.parse(readFileSync(join(tmp, ".ideaspaces", "spaces.json"), "utf-8"));
    const key = Object.keys(map).find((k) => k.endsWith("my-space"))!;
    expect(map[key]).toEqual({ repo_id: "repo_abc", slug: "my-space", namespace: "ernests_s" });
  });

  it("uses --hostname for org spaces", async () => {
    const dir = initLocalRepo("org-notes");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_org", slug: "org-notes", name: "org-notes" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setupBareRemote("acme.com", "org-notes");

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], { hostname: "acme.com" }, baseGlobal);
    expect(exit).toBe(0);

    const origin = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(origin).toContain("/acme.com/org-notes.git");
  });

  it("surfaces a readable error when git push itself fails", async () => {
    const dir = initLocalRepo("push-fail");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_x", slug: "push-fail", name: "push-fail" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // IS_GIT_URL points at a directory that doesn't exist, so `git push` to
    // file://<missing>/<namespace>/<slug>.git fails. Exit 1, no spaces.json
    // (the save happens after a successful push).
    process.env.IS_GIT_URL = `file://${join(tmp, "does-not-exist")}`;

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
    expect(existsSync(join(tmp, ".ideaspaces", "spaces.json"))).toBe(false);
  });

  it("surfaces a readable error when /repos rejects (e.g. 409 slug conflict)", async () => {
    const dir = initLocalRepo();
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response('{"detail":"slug already taken"}', { status: 409 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
    // /auth/me succeeded, /repos failed → no spaces.json should exist.
    expect(existsSync(join(tmp, ".ideaspaces", "spaces.json"))).toBe(false);
  });

  it("re-publish from same dir reuses the existing repo (no second createRepo)", async () => {
    const dir = initLocalRepo("reused");
    process.chdir(dir);
    await writeCredentials();

    let createCallCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        createCallCount += 1;
        const repoId = createCallCount === 1 ? "repo_first" : "repo_second";
        return new Response(
          JSON.stringify({ repo_id: repoId, slug: "reused", name: "reused" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupBareRemote("ernests_s", "reused");

    const spacesPath = join(tmp, ".ideaspaces", "spaces.json");
    const readSpaceRecord = () => {
      const map = JSON.parse(readFileSync(spacesPath, "utf-8"));
      return map[Object.keys(map).find((k) => k.endsWith("reused"))!];
    };

    const { publishCommand } = await import("../commands/publish.js");

    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(1);
    expect(readSpaceRecord().repo_id).toBe("repo_first");

    // Second publish from the same dir — should reuse, not create again.
    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(1);
    expect(readSpaceRecord().repo_id).toBe("repo_first");

    // --force opts into a fresh remote and replaces the local mapping.
    expect(await publishCommand.run([], { force: true }, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(2);
    expect(readSpaceRecord().repo_id).toBe("repo_second");
  });

  it("rejects --name / --slug / --hostname on re-publish without --force", async () => {
    const dir = initLocalRepo("reject-flags");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) return authMeResponse();
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_x", slug: "reject-flags", name: "n" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupBareRemote("ernests_s", "reject-flags");

    const { publishCommand } = await import("../commands/publish.js");
    // First publish succeeds and writes to spaces.json.
    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
    // Re-publish with --name silently mapped to nothing → reject.
    expect(await publishCommand.run([], { name: "Something Else" }, baseGlobal)).toBe(1);
    // Same for --slug and --hostname.
    expect(await publishCommand.run([], { slug: "other" }, baseGlobal)).toBe(1);
    expect(await publishCommand.run([], { hostname: "x.com" }, baseGlobal)).toBe(1);
  });

  it("errors on detached HEAD", async () => {
    const dir = initLocalRepo("detached");
    process.chdir(dir);
    await writeCredentials();
    // Detach HEAD by checking out the commit SHA directly.
    const sha = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    spawnSync("git", ["-C", dir, "checkout", "--detach", sha]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
  });

  it("errors when /auth/me returns no username", async () => {
    const dir = initLocalRepo("no-username");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            user_id: 1,
            username: null,
            email: null,
            name: null,
            repos: [],
            onboarding_complete: false,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(1);
  });
});

describe("deriveGitBase", () => {
  let originalGitUrl: string | undefined;

  beforeEach(() => {
    originalGitUrl = process.env.IS_GIT_URL;
    delete process.env.IS_GIT_URL;
  });
  afterEach(() => {
    if (originalGitUrl !== undefined) process.env.IS_GIT_URL = originalGitUrl;
    else delete process.env.IS_GIT_URL;
  });

  it("swaps `api.` for `git.` on the hostname", async () => {
    const { deriveGitBase } = await import("../commands/publish.js");
    expect(deriveGitBase("https://api.ideaspaces.xyz")).toBe("https://git.ideaspaces.xyz");
    expect(deriveGitBase("https://api.ideaspaces.xyz/")).toBe("https://git.ideaspaces.xyz");
    expect(deriveGitBase("https://api.staging.ideaspaces.xyz")).toBe("https://git.staging.ideaspaces.xyz");
  });

  it("passes through hostnames without `api.` prefix (caller should set IS_GIT_URL)", async () => {
    const { deriveGitBase } = await import("../commands/publish.js");
    expect(deriveGitBase("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("IS_GIT_URL env override wins", async () => {
    process.env.IS_GIT_URL = "http://git.localhost:9000";
    const { deriveGitBase } = await import("../commands/publish.js");
    expect(deriveGitBase("https://api.ideaspaces.xyz")).toBe("http://git.localhost:9000");
  });
});

describe("slugify", () => {
  let slugify: (input: string) => string;

  beforeAll(async () => {
    ({ slugify } = await import("../commands/publish.js"));
  });

  it("camelCase basenames split on caps", () => {
    expect(slugify("TheKnowledgeSpace")).toBe("the-knowledge-space");
    expect(slugify("myNotes")).toBe("my-notes");
  });

  it("lowercase + dash basenames pass through", () => {
    expect(slugify("my-notes")).toBe("my-notes");
    expect(slugify("notes")).toBe("notes");
  });

  it("non-alphanumeric runs collapse to a single dash", () => {
    expect(slugify("My Space (v2)")).toBe("my-space-v2");
    expect(slugify("a/b\\c")).toBe("a-b-c");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("---abc---")).toBe("abc");
    expect(slugify("---ABC")).toBe("abc");
  });

  it("empty / non-alphanumeric input falls back to `space`", () => {
    expect(slugify("")).toBe("space");
    expect(slugify("___")).toBe("space");
  });

  it("caps length at 64 chars", () => {
    const s = slugify("a".repeat(100));
    expect(s.length).toBeLessThanOrEqual(64);
  });

  it("consecutive uppercase collapses to a single lowercased word", () => {
    // Documented edge case — split fires only when lowercase/digit
    // precedes uppercase, so `XML` runs don't get dashed.
    expect(slugify("XMLSpace")).toBe("xmlspace");
  });
});
