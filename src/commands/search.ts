/**
 * `ideaspaces search <query>` — local full-text search over Markdown.
 *
 * Runs entirely on files on disk (no network): lists Markdown, streams each
 * through the BM25 scorer, and prints the top matches. The query is plain
 * words plus `tag:`, `in:`, `kind:` and `author:` filters (search-query.ts).
 *
 * Without `--root`, it searches the current repository, and `--json` also
 * carries the hits as a portable Map when the repository passes the one
 * portability gate `look` uses (identified, pinned, clean, every hit tracked
 * at an unchanged HEAD): `map_status: "available"` with `map`, else
 * `"projection_pending"` with `map: null`. See search-map.ts.
 *
 * With one or more `--root <dir>`, it searches all of them as one corpus —
 * shared n, df and avgdl, so hits from different repos rank against each
 * other — and reports each root's own count or error. A root that fails does
 * not stop the others. The desktop's search drives this form. No Map is
 * projected across several roots.
 */

import { parseFrontmatter } from "@ideaspaces/protocol";
import { basename, relative } from "node:path";
import { GitError, headSha, repoRoot } from "../git.js";
import { rankDocs, type RankedHit } from "../search.js";
import {
  acceptsFrontmatter, acceptsPath, frontmatterTags, frontmatterTextDecision, hasFilters, needsFrontmatter,
  parseQuery, QueryError, wantsThreads, type HitKind, type ParsedQuery,
} from "../search-query.js";
import {
  commonBase, hitKind, listRoots, modifiedAt, readCorpus, resolveRoots, toPosix,
  type RootListing,
} from "../search-corpus.js";
import { fold } from "../search.js";
import { projectSearchMap, searchMapLine, type SearchMapProjection } from "../search-map.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

// Bare usage (no "Usage:" prefix) — `main.ts` adds the label for `--help`, and
// the error path below adds it explicitly. Matches the convention used by the
// other commands' `usage:` fields.
const USAGE = "ideaspaces search <query> [--root <dir>]... [--threads] [--limit N] [--json]";
const DEFAULT_LIMIT = 20;
const MAX_ROOTS = 256;

const QUERY_HELP = `Query:
  words            ranked by BM25 over the text, plus a filename boost
  tag:x            frontmatter tags include x; tag:a,b is either; tag:a tag:b is both
  in:folder        under a folder, written from the search base or the file's own root
  kind:k           note, thread (README and posts), post, or readme
  author:name      frontmatter author (Thread posts)
  -word -tag:x     leave out what matches; works on every filter
  tag:"a b"        quote a value with spaces
  Case and accents fold: Pēteris finds peteris (letters with no decomposed
  form, such as ł, ø or ß, stay as written). A query of only filters lists
  every match, newest first. An unknown key: is searched as words. Put the
  query after -- when it starts with a one-letter -x word.

Roots:
  --root <dir>     search this folder; repeat for several. One corpus, one
                   ranking. A Git repo is listed by Git (untracked files in,
                   ignored files out); a plain folder is walked. A folder
                   given twice is searched once. Without --root, the
                   current repository.
  --threads        include local Threads: each root's own _threads/ READMEs
                   and posts. Implied by kind:thread, kind:post or kind:readme.`;

export interface SearchHit {
  path: string;
  /** Absolute root, in multi-root mode. */
  root?: string;
  kind: HitKind;
  /** Frontmatter `name`, else the first `# ` heading, else the file name. */
  title: string;
  summary: string | null;
  tags: string[];
  score: number;
  body_hits: number;
  name_hits: number;
  snippet: string;
  line: number | null;
  /** File modification time, ISO; null if it went away after the read. */
  updated: string | null;
  thread?: { slug: string; post_id: string | null; author: string | null; date: string | null };
}

function stem(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

function stringField(fm: Record<string, unknown> | null, key: string): string | null {
  const value = fm?.[key];
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function describe(hit: RankedHit, root: string, withRoot: boolean): SearchHit {
  const fm = hit.frontmatter ? parseFrontmatter(`${hit.frontmatter}\n`) : null;
  const kind = hitKind(hit.path);
  const out: SearchHit = {
    path: hit.path,
    ...(withRoot ? { root } : {}),
    kind,
    title: stringField(fm, "name") ?? hit.heading ?? stem(hit.path),
    summary: stringField(fm, "summary"),
    tags: frontmatterTags(fm?.tags),
    score: hit.score,
    body_hits: hit.body_hits,
    name_hits: hit.name_hits,
    snippet: hit.snippet,
    line: hit.line,
    updated: modifiedAt(root, hit.path),
  };
  if (kind !== "note") {
    out.thread = {
      slug: hit.path.split("/")[1],
      post_id: kind === "thread_post" ? stringField(fm, "id") : null,
      author: stringField(fm, "author"),
      date: stringField(fm, "date"),
    };
  }
  return out;
}

function parseLimit(flags: Record<string, unknown>): number | string {
  if (flags.limit === undefined) return DEFAULT_LIMIT;
  const raw = typeof flags.limit === "string" ? Number(flags.limit) : NaN;
  if (!Number.isInteger(raw) || raw < 1) return "--limit takes a whole number of results, 1 or more.";
  return raw;
}

function rootFlags(flags: Record<string, unknown>): string[] | null {
  const value = flags.root;
  if (value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is string => typeof v === "string");
}

interface Corpus {
  files: Array<{ root: string; path: string }>;
  base: string;
}

/** Path-level filters decide what is read at all. */
function selectFiles(listings: RootListing[], base: string, query: ParsedQuery): Corpus["files"] {
  const files: Corpus["files"] = [];
  const filtering = query.inPaths.length > 0 || query.excludeIn.length > 0 ||
    query.kinds.length > 0 || query.excludeKinds.length > 0;
  for (const listing of listings) {
    const prefix = toPosix(relative(base, listing.root));
    for (const path of listing.files) {
      if (filtering) {
        const locations = [fold(path)];
        if (prefix) locations.push(fold(`${prefix}/${path}`));
        if (!acceptsPath(query, locations, hitKind(path))) continue;
      }
      files.push({ root: listing.root, path });
    }
  }
  return files;
}

function rank(files: Corpus["files"], query: ParsedQuery, limit: number, withRoot: boolean, readCounts?: Map<string, number>) {
  const listAll = query.terms.length === 0;
  const readsFrontmatter = needsFrontmatter(query);
  const outcome = rankDocs(readCorpus(files, withRoot, readCounts), query.terms, {
    limit: listAll ? Number.MAX_SAFE_INTEGER : limit,
    exclude: query.excludeTerms,
    listWhenNoTerms: listAll,
    accept: readsFrontmatter
      ? (_doc, frontmatter) => {
        const decision = frontmatterTextDecision(query, frontmatter);
        if (decision !== "parse") return decision === "yes";
        return acceptsFrontmatter(query, parseFrontmatter(`${frontmatter}\n`));
      }
      : undefined,
  });
  return outcome;
}

/** The top hits, described. A filter-only query is a listing: newest first, then by place. */
function finish(hits: RankedHit[], root: string | null, listAll: boolean, limit: number): SearchHit[] {
  const rootOf = (hit: RankedHit) => root ?? hit.root!;
  if (!listAll) return hits.map((hit) => describe(hit, rootOf(hit), root === null));
  const dated = hits.map((hit) => ({ hit, updated: modifiedAt(rootOf(hit), hit.path) ?? "" }));
  dated.sort((a, b) => b.updated.localeCompare(a.updated) ||
    (a.hit.root ?? "").localeCompare(b.hit.root ?? "") || a.hit.path.localeCompare(b.hit.path));
  return dated.slice(0, limit).map(({ hit }) => describe(hit, rootOf(hit), root === null));
}

export const searchCommand: CommandDef = {
  name: "search",
  description: "Search Markdown locally — one repo, or several roots as one corpus (BM25 + filename, with tag:/in:/kind:/author: filters)",
  usage: USAGE,
  help: QUERY_HELP,
  examples: [
    "ideaspaces search awareness loop",
    'ideaspaces search "state and location" --limit 5',
    "ideaspaces search onboarding tag:desktop --threads",
    "ideaspaces search kind:post author:Scout   # every post by Scout, newest first",
    "ideaspaces search loopback --root ~/Vault --root ~/Vault/agents/scout --json",
    "ideaspaces search decision -in:code --root . --threads",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const raw = args.join(" ").trim();
    if (!raw) {
      output.error(`Usage: ${USAGE}\n\n${QUERY_HELP}`);
      return 1;
    }
    let query: ParsedQuery;
    try {
      query = parseQuery(raw);
    } catch (error) {
      output.error(error instanceof QueryError ? error.message : String(error));
      return 1;
    }
    if (query.terms.length === 0 && !hasFilters(query)) {
      output.error(`Nothing to search for in "${raw}". Give a word or a filter such as tag:onboarding.`);
      return 1;
    }
    if (flags.threads !== undefined && flags.threads !== true) {
      output.error("--threads does not take a value.");
      return 1;
    }
    const limit = parseLimit(flags);
    if (typeof limit === "string") {
      output.error(limit);
      return 1;
    }
    const threads = flags.threads === true || wantsThreads(query);
    const listAll = query.terms.length === 0;

    const roots = rootFlags(flags);
    if (roots !== null) {
      return searchRoots(roots, query, { limit, threads, listAll, json: global.json }, output);
    }

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(`${err instanceof GitError ? err.message : String(err)}. Run inside a repository, or name folders with --root <dir>.`);
      return 1;
    }

    // HEAD is observed before any file is read; the Map is sealed only if it
    // is the same afterwards.
    let headBefore: string | null;
    try {
      headBefore = headSha(root);
    } catch {
      headBefore = null; // unborn HEAD: results still come, the Map does not
    }
    const [listing] = await listRoots([root], threads);
    if (listing.error) {
      output.error(listing.error);
      return 1;
    }
    const files = selectFiles([listing], root, query);
    const outcome = rank(files, query, limit, false);
    const results = finish(outcome.hits, root, listAll, limit);

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
      query: raw,
      // Files actually read: tracked-but-deleted, oversized and unreadable files are not counted.
      scanned: outcome.scanned,
      total: results.length,
      matched: outcome.matched,
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
      output.result(data, `No matches for "${raw}" (${outcome.scanned} files searched).\n${searchMapLine(projection)}`);
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

async function searchRoots(
  inputs: string[],
  query: ParsedQuery,
  options: { limit: number; threads: boolean; listAll: boolean; json: boolean },
  output: ReturnType<typeof createOutput>,
): Promise<number> {
  if (inputs.length === 0) {
    output.error("--root needs a folder, for example --root ~/Vault.");
    return 1;
  }
  if (inputs.length > MAX_ROOTS) {
    output.error(`Too many roots (${inputs.length}); search takes at most ${MAX_ROOTS}.`);
    return 1;
  }
  const requests = resolveRoots(inputs);
  const usable = requests.filter((r): r is { input: string; root: string } => r.root !== null).map((r) => r.root);
  const listings = await listRoots(usable, options.threads);
  const base = commonBase(usable);
  const files = selectFiles(listings.filter((l) => !l.error), base, query);
  const readCounts = new Map<string, number>();
  const outcome = rank(files, query, options.limit, true, readCounts);
  const results = finish(outcome.hits, null, options.listAll, options.limit);

  const listed = new Map<string, number>();
  for (const file of files) listed.set(file.root, (listed.get(file.root) ?? 0) + 1);
  const listingByRoot = new Map(listings.map((l) => [l.root, l]));
  const rootRows = requests.map((request) => {
    if (request.root === null) return { root: request.input, listed: 0, scanned: 0, error: request.error };
    const listing = listingByRoot.get(request.root)!;
    return {
      root: request.root,
      listing: listing.listing,
      // Listed to search; read is `scanned` (deleted, oversized or unreadable files drop out).
      listed: listed.get(request.root) ?? 0,
      scanned: readCounts.get(request.root) ?? 0,
      ...(listing.error ? { error: listing.error } : {}),
      ...(listing.truncated ? { truncated: true } : {}),
      ...(listing.warnings ? { warnings: listing.warnings } : {}),
    };
  });
  const failed = rootRows.filter((row) => "error" in row && row.error);
  const complete = failed.length === 0 && !rootRows.some((row) => "truncated" in row && row.truncated);

  const data = {
    query: query.raw,
    base,
    scanned: outcome.scanned,
    total: results.length,
    matched: outcome.matched,
    complete,
    results,
    roots: rootRows,
  };
  if (usable.length === 0 || failed.length === rootRows.length) {
    // Exit 1, but a JSON caller still gets every root's reason in the usual shape.
    const reasons = failed.map((row) => `  ${row.root}: ${row.error}`).join("\n");
    const hint = "Check each path exists and is a folder you can read; a relative --root is taken from the current directory.";
    if (options.json) output.result(data, "");
    output.error(`No root could be searched:\n${reasons}\n${hint}`);
    return 1;
  }
  const notes = rootRows.flatMap((row) => [
    ...("error" in row && row.error ? [`Could not search ${row.root}: ${row.error}`] : []),
    ...("truncated" in row && row.truncated ? [`Stopped early in ${row.root}: too many files to walk`] : []),
  ]);
  const footer = `${files.length} files in ${rootRows.length - failed.length} root${rootRows.length - failed.length === 1 ? "" : "s"}` +
    (notes.length ? `\n${notes.join("\n")}` : "");
  if (results.length === 0) {
    output.result(data, `No matches for "${query.raw}".\n${footer}`);
    return 0;
  }
  const lines = results.map((r) => {
    const where = toPosix(relative(base, `${r.root}/${r.path}`)) || r.path;
    const head = `${where}${r.line ? `:${r.line}` : ""}  ${r.title}`;
    return r.snippet ? `${head}\n    ${r.snippet}` : head;
  });
  output.result(data, `${lines.join("\n")}\n\n${footer}`);
  return 0;
}
