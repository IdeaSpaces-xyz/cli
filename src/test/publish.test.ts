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

function initLocalRepo(name = "my-space") {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", dir, "config", "user.email", "local@example.com"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "Local"]);
  writeFileSync(join(dir, "foo.md"), "# foo\n");
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
        return new Response(
          JSON.stringify({ repo_id: "repo_first", slug: "reused", name: "reused" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupBareRemote("ernests_s", "reused");

    const { publishCommand } = await import("../commands/publish.js");
    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(1);

    // Second publish from the same dir — should reuse, not create again.
    expect(await publishCommand.run([], {}, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(1);

    // --force opts into a fresh remote.
    expect(await publishCommand.run([], { force: true }, baseGlobal)).toBe(0);
    expect(createCallCount).toBe(2);
  });
});
