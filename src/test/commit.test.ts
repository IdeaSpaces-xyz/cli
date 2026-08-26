import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCommand } from "../commands/commit.js";
import { gitignoreDefaults } from "../templates/default.js";
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

describe("ideaspaces commit — renames, deletions, unknown paths", () => {
  // Named paths commit in whatever state the tree holds. The add pre-stage
  // covers only worktree-existing paths (git add fatals on a mv'd source or
  // git-rm'd file — they live only in HEAD); the commit pathspec matches HEAD,
  // so renames and deletions commit, and a never-existed path refuses the
  // whole commit.
  async function seed(name: string, content = "x") {
    await fs.writeFile(join(tmp, name), content, "utf-8");
    git(["add", name]);
    git(["commit", "-q", "-m", `seed ${name}`]);
  }

  it("commits a staged rename when given both paths", async () => {
    await seed("a.md");
    git(["mv", "a.md", "b.md"]);
    const exit = await commitCommand.run(["a.md", "b.md"], { m: "Move a to b" }, G);
    expect(exit).toBe(0);
    const status = git(["show", "--name-status", "--format=", "-M", "HEAD"]).trim();
    expect(status).toBe("R100\ta.md\tb.md");
  });

  it("commits a git rm'd (staged) deletion", async () => {
    await seed("gone.md");
    git(["rm", "-q", "gone.md"]);
    expect(await commitCommand.run(["gone.md"], { m: "Delete gone" }, G)).toBe(0);
    expect(git(["show", "--name-status", "--format=", "HEAD"]).trim()).toBe("D\tgone.md");
  });

  it("commits a plain rm'd (unstaged) deletion", async () => {
    await seed("gone2.md");
    await fs.rm(join(tmp, "gone2.md"));
    expect(await commitCommand.run(["gone2.md"], { m: "Delete gone2" }, G)).toBe(0);
    expect(git(["show", "--name-status", "--format=", "HEAD"]).trim()).toBe("D\tgone2.md");
  });

  it("refuses the WHOLE commit when any named path never existed", async () => {
    await seed("base.md");
    await fs.writeFile(join(tmp, "good.md"), "y", "utf-8");
    const head = git(["rev-parse", "HEAD"]);
    expect(await commitCommand.run(["good.md", "typo.md"], { m: "x" }, G)).toBe(1);
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });

  it("commits a mixed set — rename + new + modified — and nothing else", async () => {
    await seed("keep.md");
    await seed("old.md");
    git(["mv", "old.md", "new.md"]);
    await fs.writeFile(join(tmp, "keep.md"), "changed", "utf-8");
    await fs.writeFile(join(tmp, "fresh.md"), "fresh", "utf-8");
    await fs.writeFile(join(tmp, "bystander.md"), "bystander", "utf-8");

    const exit = await commitCommand.run(["old.md", "new.md", "keep.md", "fresh.md"], { m: "mixed" }, G);
    expect(exit).toBe(0);
    const lines = git(["show", "--name-status", "--format=", "-M", "HEAD"]).split("\n").filter(Boolean).sort();
    expect(lines).toEqual(["A\tfresh.md", "M\tkeep.md", "R100\told.md\tnew.md"].sort());
    expect(git(["status", "--porcelain", "--", "bystander.md"]).trim()).toBe("?? bystander.md");
  }, 15_000);
});

describe("ideaspaces commit — explicit Git identity", () => {
  it("uses repo-local identity without credentials or network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await fs.mkdir(join(tmp, ".ideaspaces"), { recursive: true });
    await fs.writeFile(
      join(tmp, ".ideaspaces", "credentials.json"),
      JSON.stringify({ api_url: "https://api.test", api_key: "k_test" }) + "\n",
    );
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    expect(await commitCommand.run(["note.md"], { m: "save" }, G)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "T <t@e.com>|T <t@e.com>",
    );
  });

  it("accepts an explicit author pair without mutating local config", async () => {
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    expect(
      await commitCommand.run(
        ["note.md"],
        { m: "save", "author-name": "Alice Smith", "author-email": "person:alice@ideaspaces" },
        G,
      ),
    ).toBe(0);
    expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Alice Smith <person:alice@ideaspaces>|Alice Smith <person:alice@ideaspaces>",
    );
    expect(git(["config", "--local", "user.email"])).toBe("t@e.com");
    expect(git(["config", "--local", "user.name"])).toBe("T");
  });

  it("sanitizes Git identity environment overrides", async () => {
    const saved = {
      author: process.env.GIT_AUTHOR_EMAIL,
      committer: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_AUTHOR_EMAIL = "ambient-author@example.com";
    process.env.GIT_COMMITTER_EMAIL = "ambient-committer@example.com";
    try {
      await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");
      expect(await commitCommand.run(["note.md"], { m: "save" }, G)).toBe(0);
      expect(git(["log", "-1", "--format=%ae|%ce"])).toBe("t@e.com|t@e.com");
    } finally {
      if (saved.author === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = saved.author;
      if (saved.committer === undefined) delete process.env.GIT_COMMITTER_EMAIL;
      else process.env.GIT_COMMITTER_EMAIL = saved.committer;
    }
  });

  it("preserves terminal compatibility with effective global Git identity", async () => {
    spawnSync("git", ["config", "--local", "--unset", "user.name"], { cwd: tmp });
    spawnSync("git", ["config", "--local", "--unset", "user.email"], { cwd: tmp });
    spawnSync("git", ["config", "--global", "user.name", "Global Person"], { cwd: tmp });
    spawnSync("git", ["config", "--global", "user.email", "global@example.com"], { cwd: tmp });
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    expect(await commitCommand.run(["note.md"], { m: "save" }, G)).toBe(0);
    expect(git(["log", "-1", "--format=%an <%ae>"])).toBe(
      "Global Person <global@example.com>",
    );
  });

  it("refuses an incomplete explicit pair before staging", async () => {
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");
    expect(
      await commitCommand.run(["note.md"], { m: "save", "author-name": "Alice" }, G),
    ).toBe(1);
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
  });

  it("refuses when no effective or explicit identity exists", async () => {
    spawnSync("git", ["config", "--local", "--unset", "user.name"], { cwd: tmp });
    spawnSync("git", ["config", "--local", "--unset", "user.email"], { cwd: tmp });
    await fs.writeFile(join(tmp, "note.md"), "# Note", "utf-8");

    expect(await commitCommand.run(["note.md"], { m: "save" }, G)).toBe(1);
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
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
        "co-author": "agent:me-claude@ideaspaces,agent:pair",
      },
      G,
    );
    expect(exit).toBe(0);
    const msg = git(["log", "-1", "--format=%B"]);
    expect(msg).toContain("Capture auth decision");
    expect(msg).toContain("Op: capture");
    expect(msg).toContain("Conversation: sess_9");
    expect(msg).toContain("Co-authored-by: me-claude <agent:me-claude@ideaspaces>");
    expect(msg).toContain("Co-authored-by: pair <agent:pair@ideaspaces>");
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

  // Local-only state — the progress a Guide keeps on the person's own machine.
  // The scaffolded rules are what a fork receives; these assert what they buy.
  describe("local-only paths", () => {
    async function scaffoldIgnore() {
      await fs.writeFile(join(tmp, ".gitignore"), gitignoreDefaults({ privateAgent: false }));
      git(["add", ".gitignore"]);
      git(["commit", "-q", "-m", "ignore"]);
    }

    it("leaves the tree clean when local progress is written", async () => {
      await scaffoldIgnore();
      await fs.writeFile(join(tmp, "progress.local.md"), "# done: first space\n");
      expect(git(["status", "--porcelain"])).toBe("");
    });

    it("refuses to commit a local-only path, and commits nothing", async () => {
      await scaffoldIgnore();
      await fs.writeFile(join(tmp, "progress.local.md"), "# done: first space\n");
      const before = git(["rev-parse", "HEAD"]);

      expect(await commitCommand.run(["progress.local.md"], { m: "save progress" }, G)).toBe(1);
      expect(git(["rev-parse", "HEAD"])).toBe(before);
    });

    it("refuses the whole commit when one named path is local-only", async () => {
      await scaffoldIgnore();
      await fs.writeFile(join(tmp, "note.md"), "# note\n");
      await fs.writeFile(join(tmp, "progress.local.md"), "# progress\n");
      const before = git(["rev-parse", "HEAD"]);

      expect(
        await commitCommand.run(["note.md", "progress.local.md"], { m: "both" }, G),
      ).toBe(1);
      // Not a partial save: the good path stays uncommitted too.
      expect(git(["rev-parse", "HEAD"])).toBe(before);
      expect(git(["status", "--porcelain"])).toContain("note.md");
    });

    it("still commits a tracked file that a later rule would match", async () => {
      // An ignore rule over an already-tracked path is inert in git, and the
      // refusal must not be stricter than git itself.
      await fs.writeFile(join(tmp, "kept.local.md"), "# tracked before the rule\n");
      git(["add", "-f", "kept.local.md"]);
      git(["commit", "-q", "-m", "track it"]);
      await scaffoldIgnore();
      await fs.writeFile(join(tmp, "kept.local.md"), "# edited after the rule\n");

      expect(await commitCommand.run(["kept.local.md"], { m: "edit tracked" }, G)).toBe(0);
      expect(git(["log", "-1", "--format=%s"])).toBe("edit tracked");
    });
  });
});
