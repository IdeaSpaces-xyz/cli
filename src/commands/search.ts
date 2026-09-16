/**
 * `ideaspaces search <query>` — local, repo-level full-text search.
 *
 * Runs entirely on the clone's files on disk (no network): lists the repo's
 * Markdown via `git ls-files`, streams each through the BM25 scorer, and prints
 * the top matches. The desktop drives it with the clone as cwd and renders
 * `--json`; from a terminal it prints a ranked, snippeted list.
 *
 * `--json` also carries the hits as a portable Map when the repository passes
 * the one portability gate `look` uses (identified, pinned, clean, every hit
 * tracked at an unchanged HEAD): `map_status: "available"` with `map`, else
 * `"projection_pending"` with `map: null`. Rank, score, snippet, and line stay
 * in `results`; member order carries the rank. See search-map.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, listFiles, headSha, GitError } from "../git.js";
import { searchDocs, type SearchDoc } from "../search.js";
import { projectSearchMap, searchMapLine, type SearchMapProjection } from "../search-map.js";
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

    // HEAD is observed before any file is read; the Map is sealed only if it
    // is the same afterwards.
    let headBefore: string | null;
    try {
      headBefore = headSha(root);
    } catch {
      headBefore = null; // unborn HEAD: results still come, the Map does not
    }
    const markdown = listFiles(root).filter((p) => p.endsWith(".md"));
    const results = searchDocs(readDocs(root, markdown), query, limit);

    let projection: SearchMapProjection;
    try {
      projection = projectSearchMap(root, headBefore, results.map((r) => r.path));
    } catch (error) {
      // Portability is stricter than search. Keep the ranked result; omit the Map.
      projection = {
        map_status: "projection_pending",
        map: null,
        root: { local_path: root, sha: headBefore },
        dirty: null,
        local_only_paths: [],
        portability_issue: `Could not verify a portable Map root: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const data = {
      query,
      scanned: markdown.length,
      total: results.length,
      results,
      map_status: projection.map_status,
      map: projection.map,
      root: projection.root,
      dirty: projection.dirty,
      local_only_paths: projection.local_only_paths,
      ...(projection.map_issues ? { map_issues: projection.map_issues } : {}),
      ...(projection.portability_issue ? { portability_issue: projection.portability_issue } : {}),
    };
    if (results.length === 0) {
      output.result(data, `No matches for "${query}" (${markdown.length} files searched).\n${searchMapLine(projection)}`);
      return 0;
    }

    const lines = results.map((r) => {
      const where = r.line ? `:${r.line}` : "";
      const head = `${r.path}${where}`;
      return r.snippet ? `${head}\n    ${r.snippet}` : head;
    });
    output.result(data, `${lines.join("\n")}\n\n${searchMapLine(projection)}`);
    return 0;
  },
};
