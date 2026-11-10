/**
 * The search query language: plain words for BM25, plus a few `key:value`
 * filters a person or an agent can type without learning anything else.
 *
 *   loopback page                 words, ranked by BM25 + filename
 *   tag:onboarding                frontmatter `tags` contains "onboarding"
 *   tag:auth,login                … contains "auth" or "login"
 *   tag:auth tag:desktop          … contains both
 *   in:agents/integrator          under that folder (from the search base or the file's root)
 *   kind:thread                   Thread READMEs and posts (also: note, post, readme)
 *   author:Scout                  frontmatter `author` is "Scout" (Thread posts)
 *   has:map                       a readable Map, whatever the record's kind
 *   post-kind:snapshot            a system post kind, not a file kind or tag
 *   -draft  -tag:old  -in:code    leave out what matches
 *   tag:"series a"                quote a value that has spaces
 *
 * An unknown `key:` is ordinary text, so pasting a URL or `foo:bar` still
 * searches for its words. Matching folds case and diacritics: `Pēteris`,
 * `peteris` and `PETERIS` are the same word, tag, or author.
 */

import { parseMap, parseThreadPost, THREAD_KINDS } from "@ideaspaces/protocol";
import { fold, tokenize } from "./search.js";

export const QUERY_KINDS = ["note", "thread", "post", "readme"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];
/** A result's kind: what the file is inside its root. */
export type HitKind = "note" | "thread_post" | "thread_readme";

const KIND_ALIASES: Record<string, HitKind[]> = {
  note: ["note"],
  thread: ["thread_post", "thread_readme"],
  threads: ["thread_post", "thread_readme"],
  post: ["thread_post"],
  posts: ["thread_post"],
  thread_post: ["thread_post"],
  readme: ["thread_readme"],
  thread_readme: ["thread_readme"],
};

const FILTER_KEYS = new Set(["tag", "in", "kind", "author", "has", "post-kind"]);

export interface ParsedQuery {
  /** The text as given, for echoing back. */
  raw: string;
  /** Distinct folded BM25 terms. */
  terms: string[];
  /** Folded terms whose presence drops a document. */
  excludeTerms: string[];
  /** Every group must match; inside a group any tag matches (v2's `array_has_any`). */
  tags: string[][];
  excludeTags: string[];
  /** Any prefix matches. */
  inPaths: string[];
  excludeIn: string[];
  /** Any kind matches. Empty means every kind. */
  kinds: HitKind[];
  excludeKinds: HitKind[];
  authors: string[];
  excludeAuthors: string[];
  /** System post kinds, separate from the file-kind filter and retrieval tags. */
  postKinds: string[];
  excludePostKinds: string[];
  hasMap: boolean;
  excludeMap: boolean;
}

export class QueryError extends Error {}

/** Split on whitespace; a double-quoted run (anywhere in a token) keeps its spaces. */
function splitQuery(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/u.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoted) throw new QueryError('A quote is not closed. Close it, or drop the " to search for the words.');
  if (started) out.push(current);
  return out;
}

/** A folder filter as written: forward slashes, no leading `./` or `/`, no trailing `/`. */
export function normalizeFolder(value: string): string {
  return fold(value.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, ""));
}

function normalizeTag(value: string): string {
  return fold(value.trim().replace(/^#/, "").trim());
}

export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    raw, terms: [], excludeTerms: [], tags: [], excludeTags: [],
    inPaths: [], excludeIn: [], kinds: [], excludeKinds: [], authors: [], excludeAuthors: [],
    postKinds: [], excludePostKinds: [], hasMap: false, excludeMap: false,
  };
  const terms = new Set<string>();
  const excluded = new Set<string>();
  for (const token of splitQuery(raw)) {
    const negated = token.length > 1 && token.startsWith("-");
    const body = negated ? token.slice(1) : token;
    const colon = body.indexOf(":");
    const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
    if (!FILTER_KEYS.has(key)) {
      for (const term of tokenize(body)) (negated ? excluded : terms).add(term);
      continue;
    }
    const value = body.slice(colon + 1).trim();
    if (!value) throw new QueryError(`${key}: needs a value, for example ${example(key)}.`);
    switch (key) {
      case "tag": {
        const group = value.split(",").map(normalizeTag).filter(Boolean);
        if (group.length === 0) throw new QueryError(`tag: needs a value, for example ${example(key)}.`);
        if (negated) parsed.excludeTags.push(...group);
        else parsed.tags.push(group);
        break;
      }
      case "in": {
        const folder = normalizeFolder(value);
        if (!folder || folder.split("/").includes("..")) {
          throw new QueryError(`in: takes a folder inside the search, for example ${example(key)}.`);
        }
        (negated ? parsed.excludeIn : parsed.inPaths).push(folder);
        break;
      }
      case "kind": {
        const kinds: HitKind[] = [];
        for (const part of value.toLowerCase().split(",")) {
          const mapped = KIND_ALIASES[part.trim()];
          if (!mapped) throw new QueryError(`kind:${part} is not a kind. Use one of: ${QUERY_KINDS.join(", ")}.`);
          kinds.push(...mapped);
        }
        const target = negated ? parsed.excludeKinds : parsed.kinds;
        for (const kind of kinds) if (!target.includes(kind)) target.push(kind);
        break;
      }
      case "has": {
        if (value !== "map") throw new QueryError("has: takes map, for example has:map (or -has:map).");
        if (negated) parsed.excludeMap = true;
        else parsed.hasMap = true;
        break;
      }
      case "post-kind": {
        const kinds = value.toLowerCase().split(",").map((part) => part.trim());
        if (kinds.some((kind) => !THREAD_KINDS.includes(kind as typeof THREAD_KINDS[number]))) {
          throw new QueryError(`post-kind: takes a system kind: ${THREAD_KINDS.join(", ")}. Labels belong in tag:.`);
        }
        (negated ? parsed.excludePostKinds : parsed.postKinds).push(...kinds);
        break;
      }
      case "author": {
        const names = value.split(",").map((name) => fold(name.trim())).filter(Boolean);
        (negated ? parsed.excludeAuthors : parsed.authors).push(...names);
        break;
      }
    }
  }
  parsed.terms = [...terms];
  parsed.excludeTerms = [...excluded].filter((term) => !terms.has(term));
  return parsed;
}

function example(key: string): string {
  switch (key) {
    case "tag": return "tag:onboarding";
    case "in": return "in:agents/integrator";
    case "kind": return "kind:thread";
    case "has": return "has:map";
    case "post-kind": return "post-kind:snapshot";
    default: return "author:Scout";
  }
}

/** True when the query asks for anything beyond ranking words. */
export function hasFilters(q: ParsedQuery): boolean {
  return q.excludeTerms.length > 0 || q.tags.length > 0 || q.excludeTags.length > 0 ||
    q.inPaths.length > 0 || q.excludeIn.length > 0 || q.kinds.length > 0 || q.excludeKinds.length > 0 ||
    q.authors.length > 0 || q.excludeAuthors.length > 0 ||
    q.postKinds.length > 0 || q.excludePostKinds.length > 0 || q.hasMap || q.excludeMap;
}

/** True when the query should include local Thread files without an explicit --threads. */
export function wantsThreads(q: ParsedQuery): boolean {
  return q.hasMap || q.excludeMap || q.postKinds.length > 0 || q.excludePostKinds.length > 0 ||
    (q.kinds.length > 0 && q.kinds.every((kind) => kind !== "note"));
}

function underFolder(location: string, folder: string): boolean {
  return location === folder || location.startsWith(`${folder}/`);
}

/**
 * Path-level filters: whether a file is searched at all. `locations` are the
 * file's folded positions — from the search base and from its own root.
 */
export function acceptsPath(q: ParsedQuery, locations: string[], kind: HitKind): boolean {
  if (q.kinds.length > 0 && !q.kinds.includes(kind)) return false;
  if (q.excludeKinds.includes(kind)) return false;
  if (q.inPaths.length > 0 && !q.inPaths.some((f) => locations.some((l) => underFolder(l, f)))) return false;
  if (q.excludeIn.some((f) => locations.some((l) => underFolder(l, f)))) return false;
  return true;
}

/** Frontmatter `tags` as folded strings: a YAML list, or one comma-separated string. */
export function frontmatterTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.filter((tag): tag is string | number => typeof tag === "string" || typeof tag === "number")
    .map((tag) => normalizeTag(String(tag))).filter(Boolean);
}

/** Whether the query reads frontmatter to decide a hit. */
export function needsFrontmatter(q: ParsedQuery): boolean {
  return q.tags.length > 0 || q.excludeTags.length > 0 || q.authors.length > 0 || q.excludeAuthors.length > 0 ||
    q.hasMap || q.excludeMap || q.postKinds.length > 0 || q.excludePostKinds.length > 0;
}

/**
 * A cheap textual test on the raw frontmatter block, so most documents are
 * decided without parsing YAML: "no" when the filters cannot match, "yes"
 * when nothing they read is present and none is required, else "parse".
 */
export function frontmatterTextDecision(q: ParsedQuery, block: string | null): "yes" | "no" | "parse" {
  // Map/kind semantics need the actual YAML and the post reader, not a text heuristic.
  if (q.hasMap || q.excludeMap || q.postKinds.length || q.excludePostKinds.length) return "parse";
  const required = q.tags.length > 0 || q.authors.length > 0;
  if (block === null) return required ? "no" : "yes";
  const text = fold(block);
  // A key may be bare, quoted, or inside a flow mapping; when unsure, the answer is "parse".
  const hasTags = /(^|[{,])\s*["']?tags["']?\s*:/m.test(text);
  const hasAuthor = /(^|[{,])\s*["']?author["']?\s*:/m.test(text);
  if (q.tags.length > 0) {
    if (!hasTags) return "no";
    if (!q.tags.every((group) => group.some((tag) => text.includes(tag)))) return "no";
  }
  if (q.authors.length > 0) {
    if (!hasAuthor) return "no";
    if (!q.authors.some((author) => text.includes(author))) return "no";
  }
  if (!required) {
    const tagsMatter = q.excludeTags.length > 0 && hasTags && q.excludeTags.some((tag) => text.includes(tag));
    const authorMatters = q.excludeAuthors.length > 0 && hasAuthor && q.excludeAuthors.some((a) => text.includes(a));
    if (!tagsMatter && !authorMatters) return "yes";
  }
  return "parse";
}

/** Frontmatter-level filters, applied to a document that already hit. */
export function acceptsFrontmatter(
  q: ParsedQuery, frontmatter: Record<string, unknown> | null, kind: HitKind = "note", raw?: string,
): boolean {
  if (!needsFrontmatter(q)) return true;
  const parsedPost = kind === "thread_post" && raw ? parseThreadPost(`${raw}\n`) : undefined;
  const post = parsedPost?.status === "valid" ? parsedPost.post : undefined;
  if (q.hasMap || q.excludeMap) {
    // A Thread Map keeps surviving members exactly as its normal reader does.
    const hasMap = kind === "thread_post"
      ? post?.mapResult?.status === "valid"
      : parseMap(frontmatter?.map).status === "valid";
    if (q.hasMap && !hasMap) return false;
    if (q.excludeMap && hasMap) return false;
  }
  if (q.postKinds.length > 0 && (!post || !q.postKinds.includes(post.kind))) return false;
  if (post && q.excludePostKinds.includes(post.kind)) return false;
  const tags = new Set(frontmatterTags(frontmatter?.tags));
  if (!q.tags.every((group) => group.some((tag) => tags.has(tag)))) return false;
  if (q.excludeTags.some((tag) => tags.has(tag))) return false;
  const author = typeof frontmatter?.author === "string" ? fold(frontmatter.author.trim()) : null;
  if (q.authors.length > 0 && (author === null || !q.authors.includes(author))) return false;
  if (author !== null && q.excludeAuthors.includes(author)) return false;
  return true;
}
