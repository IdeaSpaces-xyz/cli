import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFileHistory, getFileHistoryDetails } from "../git.js";
import { nodeCommand } from "../commands/node.js";
import { historyCommand } from "../commands/history.js";
import type { GlobalFlags } from "../types.js";

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let tmp: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

function git(args: string[], options?: { date?: string; env?: Record<string, string> }): string {
  const env = {
    ...process.env,
    ...(options?.date
      ? { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date }
      : {}),
    ...options?.env,
  };
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function commitNote(
  file: string,
  content: string,
  message: string,
  options?: { date?: string; trailers?: Record<string, string | string[]> },
): Promise<string> {
  const fullPath = join(tmp, file);
  await fs.mkdir(join(fullPath, ".."), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  git(["add", file]);

  let fullMessage = message;
  if (options?.trailers) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(options.trailers)) {
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    fullMessage += "\n\n" + lines.join("\n");
  }

  git(["commit", "-q", "-m", fullMessage], { date: options?.date });
  return git(["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-history-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "alice@example.test"]);
  git(["config", "user.name", "Alice"]);

  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(async () => {
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
  await rm(tmp, { recursive: true, force: true });
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("getFileHistory & getFileHistoryDetails", () => {
  it("extracts trailers including Change-Id, Co-authored-by, Op, Conversation, Turn", async () => {
    const sha = await commitNote("notes/a.md", "# A", "Initial note with change", {
      date: "2026-10-01T12:00:00+0000",
      trailers: {
        "Change-Id": "chg_initial_123",
        "Co-authored-by": ["Bob <bob@example.test>", "Carol <carol@example.test>"],
        "Op": "create",
        "Conversation": "c_thread123",
        "Turn": "3",
      },
    });

    const entries = getFileHistory("notes/a.md", { cwd: tmp });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      sha,
      message: "Initial note with change",
      date: "2026-10-01 12:00:00 +0000",
      author: "Alice",
      change_id: "chg_initial_123",
      co_authored_by: ["Bob <bob@example.test>", "Carol <carol@example.test>"],
      op: "create",
      conversation_id: "c_thread123",
      turn: 3,
    });
  });

  it("handles over 20 commits: accurately reports total count, caps history at 20, and matches created with git log --diff-filter=A", async () => {
    const initialDate = "2020-01-01T12:00:00+0000";
    await commitNote("notes/long.md", "v0", "commit 0", { date: initialDate });

    for (let i = 1; i <= 25; i++) {
      const year = 2021 + i;
      await commitNote("notes/long.md", `v${i}`, `commit ${i}`, {
        date: `${year}-01-01T12:00:00+0000`,
        trailers: i === 25 ? { "Change-Id": "chg_latest_999", "Co-authored-by": "Partner <p@ideaspaces>" } : undefined,
      });
    }

    const details = getFileHistoryDetails("notes/long.md", { maxEntries: 20, cwd: tmp });

    // Total must be 26 (commit 0 + 25 updates)
    expect(details.total).toBe(26);
    // History list capped at 20
    expect(details.entries).toHaveLength(20);

    // Newest commit carries trailers
    expect(details.entries[0]?.message).toBe("commit 25");
    expect(details.entries[0]?.change_id).toBe("chg_latest_999");
    expect(details.entries[0]?.co_authored_by).toEqual(["Partner <p@ideaspaces>"]);

    // Created date matches initial commit and git log --diff-filter=A
    const diffFilterDate = git(["log", "--follow", "--diff-filter=A", "--format=%ai", "-1", "--", "notes/long.md"]);
    expect(details.created).toBe(diffFilterDate);
    expect(details.created).toBe("2020-01-01 12:00:00 +0000");

    // Oldest entry in page is commit 6 (since page has 20 newest commits 25..6), NOT commit 0
    expect(details.entries[details.entries.length - 1]?.message).toBe("commit 6");
    expect(details.created).not.toBe(details.entries[details.entries.length - 1]?.date);
  });

  it("follows file renames across history", async () => {
    const initialDate = "2022-01-01T10:00:00+0000";
    await commitNote("old-name.md", "hello", "initial create", { date: initialDate });

    // Rename file
    git(["mv", "old-name.md", "renamed.md"]);
    git(["commit", "-q", "-m", "rename old-name.md to renamed.md"], { date: "2023-01-01T10:00:00+0000" });

    // Subsequent edit
    await commitNote("renamed.md", "hello world", "edit renamed", { date: "2024-01-01T10:00:00+0000" });

    const details = getFileHistoryDetails("renamed.md", { cwd: tmp });
    expect(details.total).toBe(3);
    expect(details.created).toBe("2022-01-01 10:00:00 +0000");
  });

  it("handles co-authors with commas in their names without corrupting values", async () => {
    const sha = await commitNote("notes/comma.md", "# Comma", "Commit with comma author", {
      date: "2026-10-01T12:00:00+0000",
      trailers: {
        "Co-authored-by": "Doe, Jane <j@example.test>",
      },
    });

    const entries = getFileHistory("notes/comma.md", { cwd: tmp });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.co_authored_by).toEqual(["Doe, Jane <j@example.test>"]);
  });

  it("returns empty history for untracked / non-existent file", () => {
    const details = getFileHistoryDetails("nonexistent.md", { cwd: tmp });
    expect(details.total).toBe(0);
    expect(details.created).toBeNull();
    expect(details.entries).toEqual([]);
  });
});

describe("ideaspaces node history (clone)", () => {
  it("returns note history in clone matching JSON contract", async () => {
    await commitNote("notes/feature.md", "# Feature", "Add feature note", {
      date: "2026-10-10T14:00:00+0000",
      trailers: {
        "Change-Id": "chg_feat_01",
        "Co-authored-by": "Agent <agent:integrator@ideaspaces>",
        "Op": "create",
      },
    });

    const code = await nodeCommand.run(["history", "notes/feature.md"], { cwd: tmp }, JSON_GLOBAL);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toEqual({
      path: "notes/feature.md",
      created: "2026-10-10 14:00:00 +0000",
      total: 1,
      history: [
        {
          sha: expect.stringMatching(/^[0-9a-f]{40}$/),
          message: "Add feature note",
          date: "2026-10-10 14:00:00 +0000",
          author: "Alice",
          change_id: "chg_feat_01",
          co_authored_by: ["Agent <agent:integrator@ideaspaces>"],
          op: "create",
        },
      ],
    });
  });

  it("works with top-level history command alias", async () => {
    await commitNote("notes/feature.md", "# Feature", "Add feature note", {
      date: "2026-10-10T14:00:00+0000",
      trailers: { "Change-Id": "chg_feat_01" },
    });

    const code = await historyCommand.run(["notes/feature.md"], { cwd: tmp }, JSON_GLOBAL);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.path).toBe("notes/feature.md");
    expect(parsed.history[0]?.change_id).toBe("chg_feat_01");
  });

  it("formats human output with short sha, date, author, message, change_id", async () => {
    await commitNote("notes/feature.md", "# Feature", "Add feature note", {
      date: "2026-10-10T14:00:00+0000",
      trailers: { "Change-Id": "chg_feat_01" },
    });

    const code = await nodeCommand.run(["history", "notes/feature.md"], { cwd: tmp }, TEXT_GLOBAL);

    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain("notes/feature.md (1 commit, created 2026-10-10 14:00:00 +0000)");
    expect(out).toContain("2026-10-10 Alice: Add feature note [chg_feat_01]");
  });

  it("handles relative path from subdirectories within clone", async () => {
    await commitNote("sub/dir/note.md", "content", "nested commit");

    const subDir = join(tmp, "sub");
    const code = await nodeCommand.run(["history", "dir/note.md"], { cwd: subDir }, JSON_GLOBAL);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.path).toBe("sub/dir/note.md");
    expect(parsed.total).toBe(1);
  });

  it("refuses paths outside repository", async () => {
    const code = await nodeCommand.run(["history", "../outside.md"], { cwd: tmp }, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Path is outside repository");
  });

  it("errors when note is not found and has no history", async () => {
    const code = await nodeCommand.run(["history", "does-not-exist.md"], { cwd: tmp }, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Note not found: does-not-exist.md");
  });
});
