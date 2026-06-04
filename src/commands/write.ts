/**
 * `ideaspaces write <path>` — create or update a Note locally.
 *
 * Replace-semantics for frontmatter: callers specify all Layer 1+2 fields
 * they want set; existing frontmatter is replaced wholesale (the body is
 * preserved). Use the SDK's `composeFrontmatter` for stable output.
 *
 * Refuses to overwrite an existing file unless `--force`. Stages the written
 * file by default (`--stage`, default true) — but never commits. Committing is
 * a separate, explicit save (`ideaspaces commit`); writing is just capture.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { composeFrontmatter, stripFrontmatter, type Frontmatter } from "@ideaspaces/sdk";
import { stagePaths, blobSha, GitError } from "../git.js";
import { parseBool } from "../argv.js";
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
    "ideaspaces write <path> [--name NAME] [--summary TEXT] [--tags a,b] [--attached-to ent1,ent2] [--content TEXT] [--if-match SHA] [--force] [--stage=false]",
  examples: [
    'echo "# My Note\\nContent here" | ideaspaces write notes/my-note.md --name "My Note"',
    'ideaspaces write notes/test.md --name "Test" --content "# Test\\nHello"',
    'ideaspaces write notes/test.md --content "# update" --if-match <sha>  # safe update',
    'ideaspaces write notes/test.md --content "# overwrite" --force',
    'ideaspaces write notes/test.md --content "..." --stage=false  # write without staging',
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
    // Stage by default; `--stage=false` writes without touching the index.
    const stage = parseBool(flags.stage, true);
    const ifMatch = flags["if-match"] as string | undefined;
    const absPath = resolve(path);

    if (ifMatch !== undefined) {
      // Optimistic concurrency: the caller asserts the current content sha.
      // Mismatch (including the file having vanished) refuses unless --force,
      // surfacing both shas so the caller can re-read and merge intentionally.
      // A matching if_match IS the intent to update — no separate --force needed.
      const currentSha = blobSha(absPath);
      if (currentSha !== ifMatch && !force) {
        output.error(
          `if_match mismatch for ${path}.\n` +
            `  expected: ${ifMatch}\n` +
            `  current:  ${currentSha ?? "(file absent)"}\n` +
            "Re-read the file for the current sha and retry, or pass --force to override.",
        );
        return 6;
      }
    } else if (existsSync(absPath) && !force) {
      output.error(`File exists: ${path}\nRe-run with --force to overwrite, or pass --if-match <sha> for a safe update.`);
      return 5;
    }

    // Body: if user-supplied content has its own frontmatter, strip it; the
    // composed frontmatter from flags wins (replace-semantics), including
    // intentionally dropping any pre-existing `node_id`. Platform identity
    // lives in the server index, so local writes do not generate, preserve,
    // or validate `node_id` frontmatter.
    const body = stripFrontmatter(content);
    const finalContent = composeFrontmatter(fm) + body;

    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, finalContent, "utf-8");

    let staged = false;
    if (stage) {
      try {
        stagePaths([absPath]);
        staged = true;
      } catch (err) {
        // The write succeeded; staging is best-effort (e.g. not in a repo).
        // Surface it without failing the capture.
        const msg = err instanceof GitError ? err.message : String(err);
        output.log(`Written but not staged: ${msg}`);
      }
    }

    // The new content sha — the token the caller passes as if_match to refine
    // this same file without a separate status query.
    const sha = blobSha(absPath);

    output.result(
      { path: absPath, staged, sha },
      `${staged ? "Written + staged" : "Written"}: ${absPath} (${sha ?? "unknown sha"})`,
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
