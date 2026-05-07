import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  spawnSync("mkdir", ["-p", dir]);
  return writeFile(
    join(dir, "credentials.json"),
    JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
  );
}

function initLocalRepo(name = "my-space") {
  const dir = join(tmp, name);
  spawnSync("mkdir", [dir]);
  spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", dir, "config", "user.email", "local@example.com"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "Local"]);
  spawnSync("sh", ["-c", `echo '# foo' > '${join(dir, "foo.md")}'`]);
  spawnSync("git", ["-C", dir, "add", "."]);
  spawnSync("git", ["-C", dir, "commit", "-q", "-m", "first"]);
  return dir;
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
      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            user_id: 1,
            username: "ernests_s",
            email: null,
            name: null,
            repos: [],
            onboarding_complete: true,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_abc", slug: "my-space", name: "my-space" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // Bare repo at <root>/<namespace>/<slug>.git so publish's URL builder
    // (IS_GIT_URL/<namespace>/<slug>.git) lands on a real receivable target.
    const root = join(tmp, "bare-root");
    const target = join(root, "ernests_s", "my-space.git");
    spawnSync("mkdir", ["-p", join(root, "ernests_s")]);
    spawnSync("git", ["init", "--bare", "-q", "-b", "main", target]);
    process.env.IS_GIT_URL = `file://${root}`;

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], {}, baseGlobal);
    expect(exit).toBe(0);

    // /auth/me + /repos both called
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Local git config picked up the identity email
    const cfgEmail = spawnSync("git", ["-C", dir, "config", "--local", "user.email"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(cfgEmail).toBe("person:ernests_s@ideaspaces");

    // Origin was added
    const origin = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(origin).toContain("/ernests_s/my-space.git");

    // spaces.json persisted
    expect(existsSync(join(tmp, ".ideaspaces", "spaces.json"))).toBe(true);
    const map = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(join(tmp, ".ideaspaces", "spaces.json"), "utf-8")),
    );
    const key = Object.keys(map).find((k) => k.endsWith("my-space"))!;
    expect(map[key]).toEqual({ repo_id: "repo_abc", slug: "my-space", namespace: "ernests_s" });
  });

  it("uses --hostname for org spaces", async () => {
    const dir = initLocalRepo("org-notes");
    process.chdir(dir);
    await writeCredentials();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            user_id: 1,
            username: "ernests_s",
            email: null,
            name: null,
            repos: [],
            onboarding_complete: true,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/repos")) {
        return new Response(
          JSON.stringify({ repo_id: "repo_org", slug: "org-notes", name: "org-notes" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // Bare repo at <root>/<namespace>/<slug>.git so publish's URL builder
    // (IS_GIT_URL/<namespace>/<slug>.git) lands on a real receivable target.
    const root = join(tmp, "bare-org-root");
    const target = join(root, "acme.com", "org-notes.git");
    spawnSync("mkdir", ["-p", join(root, "acme.com")]);
    spawnSync("git", ["init", "--bare", "-q", "-b", "main", target]);
    process.env.IS_GIT_URL = `file://${root}`;

    const { publishCommand } = await import("../commands/publish.js");
    const exit = await publishCommand.run([], { hostname: "acme.com" }, baseGlobal);
    expect(exit).toBe(0);

    const origin = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(origin).toContain("/acme.com/org-notes.git");
  });
});
