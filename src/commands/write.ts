/**
 * `ideaspaces write <path>` — create or update a Note locally.
 *
 * Two shapes, disambiguated by the target:
 *
 *   - **Author** one Note: `write <file> --content ...` (or pipe stdin).
 *     Composes Layer 1+2 frontmatter from flags with replace-semantics
 *     (callers own every field they set; the body is preserved), then stages.
 *   - **Batch stage** an existing set: `write <dir>` or `write a.md b.md`.
 *     The files are already authored (with their own frontmatter) — this
 *     captures the whole set in one call instead of N, and reports per-file
 *     frontmatter health so a batch is a coherence checkpoint, not a dump.
 *
 * Author mode refuses to overwrite an existing file unless `--force`. Both
 * shapes stage by default (`--stage`, default true) — but never commit.
 * Committing is a separate, explicit save (`ideaspaces commit`).
 */

import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  composeFrontmatter,
  stripFrontmatter,
  inspectFrontmatterSyntax,
  extractSummary,
  type Frontmatter,
} from "@ideaspaces/sdk";
import { stagePaths, blobSha, GitError } from "../git.js";
import { parseBool } from "../argv.js";
import { createOutput, type Output } from "../output.js";
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
    "ideaspaces write notes/                # batch-stage every .md under notes/ + report health",
    "ideaspaces write notes/a.md notes/b.md # batch-stage a set",
    "ideaspaces write notes/ --stage=false  # health check only, no staging",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const targets = args.filter(Boolean);
    if (!targets.length) {
      output.error("Usage: ideaspaces write <path> [--name NAME] [--summary TEXT]  |  write <dir>|<files...>  (batch stage)");
      return 1;
    }

    // Batch-stage mode: a directory target, or multiple targets. The files are
    // pre-authored; capture the set in one call. A lone existing file stays in
    // author mode (backward compatible) — pass a folder or 2+ paths to batch.
    if (isBatchTarget(targets)) {
      return runBatchStage(targets, flags, output);
    }

    const path = targets[0];

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

/** Batch mode triggers on a directory target or 2+ targets; a lone file authors. */
function isBatchTarget(targets: string[]): boolean {
  if (targets.length > 1) return true;
  const abs = resolve(targets[0]);
  return existsSync(abs) && statSync(abs).isDirectory();
}

/**
 * Batch-stage a pre-authored set: stage every `.md` under the targets in one
 * call and report per-file frontmatter health. Staging is best-effort (same as
 * author mode); `--stage=false` turns this into a pure health check.
 */
async function runBatchStage(
  targets: string[],
  flags: Record<string, string | boolean>,
  output: Output,
): Promise<number> {
  const stage = parseBool(flags.stage, true);
  const { files, missing, skipped } = await collectMarkdown(targets);
  if (missing.length) {
    output.log(`Not found: ${missing.join(", ")}`);
  }
  if (skipped.length) {
    output.log(`Skipped (not .md): ${skipped.join(", ")}`);
  }
  if (!files.length) {
    output.error(`No .md files found in: ${targets.join(", ")}`);
    return 1;
  }

  const report = await Promise.all(
    files.map(async (path) => {
      const content = await fs.readFile(path, "utf-8");
      return { path, issues: healthIssues(content) };
    }),
  );

  let staged = false;
  if (stage) {
    try {
      // `files` are absolute (resolved in collectMarkdown); git stages them
      // relative to the work tree, so every path must be inside the repo cwd.
      stagePaths(files);
      staged = true;
    } catch (err) {
      // Files exist; staging is best-effort (e.g. not in a repo).
      const msg = err instanceof GitError ? err.message : String(err);
      output.log(`Not staged: ${msg}`);
    }
  }

  const flagged = report.filter((r) => r.issues.length);
  const header =
    `${staged ? "Staged" : "Checked"} ${files.length} note${files.length === 1 ? "" : "s"}` +
    (flagged.length ? `; ${flagged.length} with issues:` : "; all healthy.");
  const lines = [
    header,
    ...flagged.map((r) => `  ${relative(process.cwd(), r.path)} — ${r.issues.join(", ")}`),
  ];
  output.result({ staged, count: files.length, files: report, missing, skipped }, lines.join("\n"));
  return 0;
}

/**
 * Resolve targets into a deduped, sorted list of `.md` files. Targets that
 * don't exist come back in `missing`; an explicitly-named file that exists but
 * isn't `.md` comes back in `skipped` — never silently dropped (callers pass
 * explicit lists from scripts, so a silent skip would be invisible data loss).
 * Non-`.md` files merely *encountered* while walking a directory are expected
 * and not reported.
 */
async function collectMarkdown(
  targets: string[],
): Promise<{ files: string[]; missing: string[]; skipped: string[] }> {
  const files = new Set<string>();
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const abs = resolve(t);
    if (!existsSync(abs)) {
      missing.push(t);
    } else if (statSync(abs).isDirectory()) {
      await walkMarkdown(abs, files);
    } else if (abs.endsWith(".md")) {
      files.add(abs);
    } else {
      skipped.push(t);
    }
  }
  return { files: [...files].sort(), missing, skipped };
}

/**
 * Recurse a directory collecting `.md` files. Skips dot-directories (`.git`,
 * `.claude`, `.github`, …) and `node_modules` — tool/agent state, not notes.
 * `_agent/` is not hidden, so contract markdown is still captured.
 */
async function walkMarkdown(dir: string, out: Set<string>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(p, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.add(p);
    }
  }
}

/**
 * Frontmatter-health signals for batch capture. Non-blocking — a batch always
 * stages; these surface the coherence gaps the dogfood flagged (missing Layer-1
 * fields, no lateral links) so a set gets reviewed, not dumped.
 */
function healthIssues(content: string): string[] {
  const issues: string[] = [];
  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status === "none") {
    issues.push("no frontmatter");
  } else if (syntax.status === "malformed") {
    issues.push(`malformed frontmatter (${syntax.message})`);
  }
  if (!extractSummary(content)) issues.push("no summary");
  // Markdown link in the body: `[text](target)` whose `[` isn't preceded by `!`
  // (that would be an image, not a lateral link). A thin proxy — links in code
  // blocks still count — but enough of a signal for a health hint.
  if (!/(?<!!)\[[^\]]*\]\([^)\s]+\)/.test(stripFrontmatter(content))) issues.push("no outbound links");
  return issues;
}
