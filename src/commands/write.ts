/**
 * `ideaspaces write <path>` — create or update a Note locally.
 *
 * Replace-semantics for frontmatter: callers specify all Layer 1+2 fields
 * they want set; existing frontmatter is replaced wholesale (the body is
 * preserved). Use the SDK's `composeFrontmatter` for stable output.
 *
 * Refuses to overwrite an existing file unless `--force`. Optional
 * `--commit` stages and commits after writing.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { composeFrontmatter, stripFrontmatter, type Frontmatter } from "@ideaspaces/sdk";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const writeCommand: CommandDef = {
  name: "write",
  description: "Create or update a Note (local file with Layer 1 frontmatter)",
  usage:
    "ideaspaces write <path> [--name NAME] [--summary TEXT] [--tags a,b] [--attached-to ent1,ent2] [--content TEXT] [--force] [--commit]",
  examples: [
    'echo "# My Note\\nContent here" | ideaspaces write notes/my-note.md --name "My Note"',
    'ideaspaces write notes/test.md --name "Test" --content "# Test\\nHello"',
    'ideaspaces write notes/test.md --content "# overwrite" --force',
    'ideaspaces write notes/test.md --content "..." --commit  # also git-commits',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const path = args[0];
    if (!path) {
      output.error("Usage: ideaspaces write <path> [--name NAME] [--summary TEXT]");
      return 1;
    }

    let content = flags.content as string | undefined;
    if (!content) {
      content = await readStdin();
      if (!content) {
        output.error("No content provided. Pipe content via stdin or use --content.");
        return 1;
      }
    }

    const fm: Frontmatter = {
      name: flags.name as string | undefined,
      summary: flags.summary as string | undefined,
      tags: parseList(flags.tags),
      attached_to: parseList(flags["attached-to"]),
    };
    const force = Boolean(flags.force);
    const commit = Boolean(flags.commit);
    const absPath = resolve(path);

    if (existsSync(absPath) && !force) {
      output.error(`File exists: ${path}\nRe-run with --force to overwrite.`);
      return 5;
    }

    // Body: if user-supplied content has its own frontmatter, strip it; the
    // composed frontmatter from flags wins (replace-semantics).
    const body = stripFrontmatter(content);
    const finalContent = composeFrontmatter(fm) + body;

    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, finalContent, "utf-8");

    let commitSha: string | undefined;
    if (commit) {
      try {
        commitSha = gitCommitFile(absPath, flags["commit-message"] as string | undefined);
      } catch (err) {
        output.error(
          `File written but commit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    output.result(
      { path: absPath, commit_sha: commitSha ?? null },
      commitSha
        ? `Written: ${absPath}\nCommitted: ${commitSha}`
        : `Written: ${absPath}`,
    );
    return 0;
  },
};

function parseList(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function gitCommitFile(absPath: string, message?: string): string {
  // Find the git root containing absPath; assume the user is inside a repo.
  const stage = spawnSync("git", ["add", absPath], { encoding: "utf-8" });
  if (stage.status !== 0) {
    throw new Error(stage.stderr.trim() || `git add exit ${stage.status}`);
  }
  const subject = message?.trim() || `Update ${absPath.split("/").pop()}`;
  const commit = spawnSync("git", ["commit", "-q", "-m", subject], { encoding: "utf-8" });
  if (commit.status !== 0) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || `git commit exit ${commit.status}`);
  }
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  return sha.stdout.trim();
}
