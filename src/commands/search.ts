/**
 * `ideaspaces search <query>` — local, repo-level full-text search.
 *
 * Runs entirely on the clone's files on disk (no network): lists the repo's
 * Markdown via `git ls-files`, streams each through the BM25 scorer, and prints
 * the top matches. The desktop drives it with the clone as cwd and renders
 * `--json`; from a terminal it prints a ranked, snippeted list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, listFiles, GitError } from "../git.js";
import { searchDocs, type SearchDoc } from "../search.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

// Bare usage (no "Usage:" prefix) — `main.ts` adds the label for `--help`, and
// the error path below adds it explicitly. Matches the convention used by the
// other commands' `usage:` fields.
const USAGE = "ideaspaces search <query> [--limit N] [--json]";
const DEFAULT_LIMIT = 20;

// Lazy: yields one document at a time so the scorer never holds the whole repo
// in memory. Unreadable files (races, odd permissions) are skipped, not fatal —
// a search should degrade, not abort.
function* readDocs(root: string, paths: string[]): Generator<SearchDoc> {
  for (const path of paths) {
    try {
      yield { path, content: readFileSync(join(root, path), "utf-8") };
    } catch {
      continue;
    }
  }
}

export const searchCommand: CommandDef = {
  name: "search",
  description: "Search the current repo's Markdown locally (filename + BM25 full-text)",
  usage: USAGE,
  examples: [
    "ideaspaces search awareness loop",
    'ideaspaces search "state and location" --limit 5',
    "ideaspaces search conversation --json",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const query = args.join(" ").trim();
    if (!query) {
      output.error(`Usage: ${USAGE}`);
      return 1;
    }

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof GitError ? err.message : String(err));
      return 1;
    }

    const rawLimit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const markdown = listFiles(root).filter((p) => p.endsWith(".md"));
    const results = searchDocs(readDocs(root, markdown), query, limit);

    const data = { query, scanned: markdown.length, total: results.length, results };
    if (results.length === 0) {
      output.result(data, `No matches for "${query}" (${markdown.length} files searched).`);
      return 0;
    }

    const lines = results.map((r) => {
      const where = r.line ? `:${r.line}` : "";
      const head = `${r.path}${where}`;
      return r.snippet ? `${head}\n    ${r.snippet}` : head;
    });
    output.result(data, lines.join("\n"));
    return 0;
  },
};
