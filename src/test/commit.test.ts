import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCommand } from "../commands/commit.js";
import { writeCommand } from "../commands/write.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;
let originalHome: string | undefined;

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-commit-")));
  cwd = process.cwd();
  // Isolate HOME so the identity wiring reads no real credentials and makes no
  // network call (commit now ensures attribution via the stored OAuth account).
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  process.chdir(tmp);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
});

afterEach(async () => {
  process.chdir(cwd);
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces commit", () => {
  it("refuses a bare commit with no paths", async () => {
    const exit = await commitCommand.run([], { m: "msg" }, G);
    expect(exit).toBe(1);
  });

  it("refuses without a message", async () => {
    await fs.writeFile(join(tmp, "a.md"), "x", "utf-8");
    const exit = await commitCommand.run(["a.md"], {}, G);
    expect(exit).toBe(1);
  });

  it("commits ONLY the named path, leaving unrelated staged work untouched", async () => {
    // The user has unrelated work staged.
    await fs.writeFile(join(tmp, "user-code.txt"), "user work", "utf-8");
    git(["add", "user-code.txt"]);
    // The capture.
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "Capture note" }, G);
    expect(exit).toBe(0);

    // The commit contains note.md and NOT user-code.txt.
    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(files).toEqual(["note.md"]);
    // user-code.txt is still staged, never swept into the capture commit.
    const staged = git(["diff", "--cached", "--name-only"]);
    expect(staged).toContain("user-code.txt");
  });

  it("--all commits staged ideaspace paths and leaves staged code uncommitted", async () => {
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent/now.md"), "now", "utf-8");
    await fs.writeFile(join(tmp, "app.ts"), "code", "utf-8");
    git(["add", "note.md", "_agent/now.md", "app.ts"]);

    const exit = await commitCommand.run([], { m: "save knowledge", all: true }, G);
    expect(exit).toBe(0);

    const committed = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
    expect(committed).toEqual(["_agent/now.md", "note.md"]);
    // The staged code file is left for the user — still staged, not committed.
    expect(git(["diff", "--cached", "--name-only"])).toContain("app.ts");
  });

  it("--all refuses when only non-ideaspace files are staged", async () => {
    await fs.writeFile(join(tmp, "app.ts"), "code", "utf-8");
    git(["add", "app.ts"]);
    expect(await commitCommand.run([], { m: "x", all: true }, G)).toBe(1);
  });

  it("--all refuses when nothing is staged", async () => {
    expect(await commitCommand.run([], { m: "x", all: true }, G)).toBe(1);
  });

  it("rejects combining --all with explicit paths", async () => {
    await fs.writeFile(join(tmp, "a.md"), "x", "utf-8");
    git(["add", "a.md"]);
    expect(await commitCommand.run(["a.md"], { m: "x", all: true }, G)).toBe(1);
  });

  it("write stages a path; commit --all saves it (no session ledger)", async () => {
    // Writing through the CLI stages the file in git...
    const w = await writeCommand.run(["note.md"], { content: "# Note", name: "Note" }, G);
    expect(w).toBe(0);
    expect(git(["diff", "--cached", "--name-only"])).toContain("note.md");

    // ...so commit --all finds it straight from the index — no session state.
    const c = await commitCommand.run([], { m: "save", all: true }, G);
    expect(c).toBe(0);
    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(files).toEqual(["note.md"]);
  });
});

describe("ideaspaces commit — git author identity", () => {
  // git commit takes the author email from these env vars over local config,
  // so unset the email ones to let the wired user.email be the source of truth.
  // Keep the NAME vars for a valid committer on bare CI runners.
  const ENV_EMAILS = ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"] as const;
  let savedEmails: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEmails = Object.fromEntries(ENV_EMAILS.map((k) => [k, process.env[k]]));
    for (const k of ENV_EMAILS) delete process.env[k];
    await fs.mkdir(join(tmp, ".ideaspaces"), { recursive: true });
    await fs.writeFile(
      join(tmp, ".ideaspaces", "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
  });

  afterEach(() => {
    for (const k of ENV_EMAILS) {
      if (savedEmails[k] !== undefined) process.env[k] = savedEmails[k];
      else delete process.env[k];
    }
  });

  function mockAuthMe(username: string | null, name: string | null = null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/auth/me")) {
          return new Response(
            JSON.stringify({
              user_id: 1,
              username,
              email: null,
              name,
              repos: [],
              onboarding_complete: true,
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("attributes the commit to the OAuth identity (email + display name)", async () => {
    mockAuthMe("alice", "Alice Smith");
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "save" }, G);
    expect(exit).toBe(0);

    expect(git(["config", "--local", "user.email"])).toBe("person:alice@ideaspaces");
    expect(git(["config", "--local", "user.name"])).toBe("Alice Smith");
    // The commit author reflects both.
    expect(git(["log", "-1", "--format=%an <%ae>"])).toBe("Alice Smith <person:alice@ideaspaces>");
  });

  it("falls back to the username when the account has no display name", async () => {
    mockAuthMe("alice", null);
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "save" }, G);
    expect(exit).toBe(0);
    expect(git(["config", "--local", "user.name"])).toBe("alice");
  });

  it("does not re-fetch when the local identity is already wired", async () => {
    git(["config", "user.email", "person:bob@ideaspaces"]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "save" }, G);
    expect(exit).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(git(["log", "-1", "--format=%ae"])).toBe("person:bob@ideaspaces");
  });

  it("still commits when not logged in (no credentials, no network)", async () => {
    await rm(join(tmp, ".ideaspaces"), { recursive: true, force: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    const exit = await commitCommand.run(["note.md"], { m: "save" }, G);
    expect(exit).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Falls back to the ambient identity — push would still be gated server-side.
    expect(git(["config", "--local", "user.email"])).toBe("t@e.com");
  });
});

describe("ideaspaces commit — Change-layer trailers (end-to-end)", () => {
  async function stageNote(name = "note.md"): Promise<void> {
    await fs.writeFile(join(tmp, name), "# Note", "utf-8");
    git(["add", name]);
  }

  it("stamps the trailer block onto the real commit message", async () => {
    await stageNote();
    const exit = await commitCommand.run(
      ["note.md"],
      {
        m: "Capture auth decision",
        op: "capture",
        "change-id": "chg_auth-1a2b",
        conversation: "sess_9",
        "co-author": "agent:me-claude,agent:pair",
      },
      G,
    );
    expect(exit).toBe(0);
    const msg = git(["log", "-1", "--format=%B"]);
    expect(msg).toContain("Capture auth decision");
    expect(msg).toContain("Op: capture");
    expect(msg).toContain("Conversation: sess_9");
    expect(msg).toContain("Co-authored-by: agent:me-claude");
    expect(msg).toContain("Co-authored-by: agent:pair");
    expect(msg).toContain("Change-Id: chg_auth-1a2b");
  });

  it("leaves the message plain when no trailer flags are given", async () => {
    await stageNote();
    expect(await commitCommand.run(["note.md"], { m: "plain save" }, G)).toBe(0);
    expect(git(["log", "-1", "--format=%B"]).trim()).toBe("plain save");
  });

  it("refuses an invalid --change-id without creating a commit", async () => {
    await stageNote();
    expect(await commitCommand.run(["note.md"], { m: "x", "change-id": "NOTVALID" }, G)).toBe(1);
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });

  it("refuses an unknown --op without creating a commit", async () => {
    await stageNote();
    expect(await commitCommand.run(["note.md"], { m: "x", op: "frobnicate" }, G)).toBe(1);
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });

  it("refuses a prefix-less --co-author without creating a commit", async () => {
    await stageNote();
    expect(await commitCommand.run(["note.md"], { m: "x", "co-author": "me-claude" }, G)).toBe(1);
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });
});
