import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommand } from "../commands/create.js";
import { captureStdout } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

const baseGlobal: GlobalFlags = {
  json: true, // suppress human output during tests
  quiet: true,
  yes: false,
  help: false,
};

let tmp: string;
let originalCwd: string;

// Tests scaffold real git repos. CI runners don't have a git user identity
// configured globally, so set per-process env vars that `git commit` honors
// without polluting the user's global git config.
beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-create-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

function configureGitIdentity(cwd: string): void {
  spawnSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", cwd, "config", "user.name", "Test"]);
}

async function expectNoNodeId(path: string): Promise<void> {
  const content = await fs.readFile(path, "utf-8");
  expect(content).not.toMatch(/^node_id:/m);
}

describe("ideaspaces create", () => {
  it("plans without applying when --yes is absent", async () => {
    const exit = await createCommand.run([], {}, baseGlobal);
    expect(exit).toBe(0);
    expect(existsSync(join(tmp, "_agent"))).toBe(false);
  });

  it("scaffolds greenfield with --yes", async () => {
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    configureGitIdentity(tmp); // git-init happened; ensure identity for any subsequent ops
    // Seed only — foundation + guide. purpose/now/next emerge in conversation.
    for (const file of ["foundation", "guide"]) {
      expect(existsSync(join(tmp, "_agent", `${file}.md`))).toBe(true);
    }
    for (const file of ["purpose", "now", "next"]) {
      expect(existsSync(join(tmp, "_agent", `${file}.md`))).toBe(false);
    }
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    await expectNoNodeId(join(tmp, "CLAUDE.md"));
    await expectNoNodeId(join(tmp, "_agent", "foundation.md"));
    await expectNoNodeId(join(tmp, "_agent", "guide.md"));
    expect(existsSync(join(tmp, ".gitignore"))).toBe(true);
    expect(existsSync(join(tmp, ".gitattributes"))).toBe(true);
    expect(existsSync(join(tmp, ".git"))).toBe(true);
  });

  it("flags nesting when creating inside an existing repo, but does not block", async () => {
    // tmp is a parent git repo; create a child space inside it.
    spawnSync("git", ["-C", tmp, "init", "-q", "-b", "main"]);
    const captured = await captureStdout(() => createCommand.run(["child"], {}, baseGlobal));
    expect(captured.exit).toBe(0);
    const result = JSON.parse(captured.out);
    // Surfaced (not silent), pointing at the parent repo root.
    expect(result.nestedInRepo).toBe(realpathSync(tmp));
    // Plan still inits an independent repo for the child — nesting is a notice,
    // not a refusal.
    expect(result.plan.some((s: { op: string }) => s.op === "git-init")).toBe(true);
  });

  it("nesting notice shows the correct relative path for a deep, not-yet-created target", async () => {
    spawnSync("git", ["-C", tmp, "init", "-q", "-b", "main"]);
    // Human mode so the notice text is rendered; a/b don't exist yet.
    const captured = await captureStdout(() =>
      createCommand.run(["a/b/space"], {}, { ...baseGlobal, json: false }),
    );
    expect(captured.exit).toBe(0);
    expect(captured.out).toContain("`a/b/space/`"); // real relative path
    expect(captured.out).not.toContain(".."); // no bogus symlink traversal (macOS)
  });

  it("does not flag nesting for a top-level (non-nested) create", async () => {
    const captured = await captureStdout(() => createCommand.run([], {}, baseGlobal));
    expect(captured.exit).toBe(0);
    expect(JSON.parse(captured.out).nestedInRepo).toBeNull();
  });

  it("creates `./<name>/` and scaffolds inside it", async () => {
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run(["my-space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    expect(existsSync(join(tmp, "my-space", "_agent", "foundation.md"))).toBe(true);
    expect(existsSync(join(tmp, "my-space", ".git"))).toBe(true);
    expect(existsSync(join(tmp, "my-space", "CLAUDE.md"))).toBe(true);
  });

  it("refuses when target is already a complete ideaspace", async () => {
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent", "foundation.md"), "# Foundation", "utf-8");
    await fs.writeFile(join(tmp, "CLAUDE.md"), "# CLAUDE", "utf-8");
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(5);
    // foundation untouched
    expect((await fs.readFile(join(tmp, "_agent", "foundation.md"), "utf-8")).trim()).toBe("# Foundation");
  });

  it("refuses on legacy _agent/ shape", async () => {
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent", "always.md"), "# legacy", "utf-8");
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(5);
  });

  it("detects code-repo signal and gitignores _agent/ by default (private)", async () => {
    await fs.writeFile(join(tmp, "package.json"), '{"name":"t"}', "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore).toContain("_agent/");
    expect(gitignore).toContain("CLAUDE.local.md");
    // CLAUDE.local.md instead of CLAUDE.md when private
    expect(existsSync(join(tmp, "CLAUDE.local.md"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("opts into shared _agent/ for code repo with --shared", async () => {
    await fs.writeFile(join(tmp, "package.json"), '{"name":"t"}', "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], { shared: true }, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("_agent/\n");
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.local.md"))).toBe(false);
  });

  it("appends to an existing .gitignore under # ideaspace defaults", async () => {
    await fs.writeFile(join(tmp, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(gitignore).toContain("# ideaspace defaults");
  });

  it("does not re-init git when target is already a repo", async () => {
    spawnSync("git", ["-C", tmp, "init", "-q", "-b", "main"]);
    configureGitIdentity(tmp);
    await fs.writeFile(join(tmp, "README.md"), "# existing", "utf-8");
    spawnSync("git", ["-C", tmp, "add", "."]);
    spawnSync("git", ["-C", tmp, "commit", "-q", "-m", "first"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    // Two commits now: initial "first" + scaffold
    const log = spawnSync("git", ["-C", tmp, "log", "--oneline"], { encoding: "utf-8" });
    expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("ideaspaces create — git author identity", () => {
  let tmp: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  const ENV_KEYS = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "is-cli-create-id-"));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.chdir(tmp);
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("sets local user.email when logged in (initial commit gets correct author)", async () => {
    // Unset GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL so git commit picks
    // up local user.email as the source of truth (env email vars
    // override config). Leave NAME env vars in place so the commit
    // has a valid committer/author name on CI runners without global
    // git config.
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
    // Pre-populate stored credentials.
    const credsDir = join(tmp, ".ideaspaces");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      join(credsDir, "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
    // Mock /auth/me.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/auth/me")) {
          return new Response(
            JSON.stringify({
              user_id: 1,
              username: "alice",
              email: null,
              name: null,
              repos: [],
              onboarding_complete: true,
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const target = join(tmp, "space");
    const { createCommand: cc } = await import("../commands/create.js");
    const exit = await cc.run(["space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);

    // Local user.email is set to the IdeaSpaces identity.
    const localEmail = spawnSync(
      "git",
      ["-C", target, "config", "--local", "user.email"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(localEmail).toBe("person:alice@ideaspaces");

    // Initial commit author email matches.
    const author = spawnSync(
      "git",
      ["-C", target, "log", "-1", "--format=%ae"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(author).toBe("person:alice@ideaspaces");
  });

  it("does not touch local git config when not logged in", async () => {
    // No credentials.json. fetch is also unstubbed so any call would throw,
    // catching a regression where the helper tries to call /auth/me anyway.
    const target = join(tmp, "space");
    const { createCommand: cc } = await import("../commands/create.js");
    const exit = await cc.run(["space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);

    // No local user.email set — git exits non-zero on missing key.
    const localEmail = spawnSync(
      "git",
      ["-C", target, "config", "--local", "--get", "user.email"],
      { encoding: "utf-8" },
    );
    expect(localEmail.status).not.toBe(0);
  });

  it("does not set identity when /auth/me returns empty username", async () => {
    // Logged in but onboarding incomplete: server returns username "".
    // Falsy guard skips the runGit call; create still scaffolds.
    const credsDir = join(tmp, ".ideaspaces");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      join(credsDir, "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            user_id: 1,
            username: "",
            email: null,
            name: null,
            repos: [],
            onboarding_complete: false,
          }),
          { status: 200 },
        ),
      ),
    );

    const target = join(tmp, "space");
    const { createCommand: cc } = await import("../commands/create.js");
    const exit = await cc.run(["space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const localEmail = spawnSync(
      "git",
      ["-C", target, "config", "--local", "--get", "user.email"],
      { encoding: "utf-8" },
    );
    expect(localEmail.status).not.toBe(0);
  });

  it("does not block scaffolding when fetchAuthMe throws (transient network)", async () => {
    // Logged in, but the auth call fails. Scaffold should still complete;
    // local user.email is just left untouched (publish recovers later).
    const credsDir = join(tmp, ".ideaspaces");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      join(credsDir, "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("simulated network failure");
      }),
    );

    const target = join(tmp, "space");
    const { createCommand: cc } = await import("../commands/create.js");
    const exit = await cc.run(["space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    // Scaffold landed.
    expect(existsSync(join(target, "_agent", "foundation.md"))).toBe(true);
    // Identity not set (we never reached the runGit config call).
    const localEmail = spawnSync(
      "git",
      ["-C", target, "config", "--local", "--get", "user.email"],
      { encoding: "utf-8" },
    );
    expect(localEmail.status).not.toBe(0);
  });

  it("does not hang scaffolding when fetchAuthMe is slow (timeout fires)", async () => {
    // Logged in, but the API hangs forever. Without a timeout, `create`
    // would block indefinitely on the /auth/me round-trip. Verify the
    // built-in timeout aborts and falls through to silent-no-op.
    const credsDir = join(tmp, ".ideaspaces");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      join(credsDir, "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        // Honor the AbortSignal so the timeout actually unblocks the test.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }),
    );

    // create's call passes timeoutMs: 2000, so AbortError fires by ~2s.
    // Bound assertion just past that to catch a regression where the
    // timeout silently stops working (test hangs to vitest default).
    const { createCommand: cc } = await import("../commands/create.js");
    const start = Date.now();
    const exit = await cc.run(["space"], {}, { ...baseGlobal, yes: true });
    const elapsed = Date.now() - start;
    expect(exit).toBe(0);
    expect(elapsed).toBeLessThan(3000);
  }, 5_000);
});
