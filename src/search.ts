/**
 * Local full-text search — pure BM25 over Markdown, plus a filename signal.
 * No index, no native deps, no network: the corpus is the files already on
 * disk, scored in a single streaming pass. One pass can span several roots;
 * n, df and avgdl are then shared, so hits from different repos rank against
 * each other.
 *
 * Why streaming, not an in-memory inverted index: this runs as a short-lived
 * verb (CLI invoke → answer → exit, or one sidecar call per desktop search).
 * We only care about the query's terms, so we never materialise the full corpus
 * — {@link rankDocs} consumes a *lazy* iterable, holding one document at a
 * time and retaining only the docs that actually hit. Peak memory scales with
 * the largest single file + the number of matches, not the corpus size.
 *
 * Deferred (qmd has these; out of scope for v1): a persisted/incremental index,
 * porter stemming, phrase queries, and any vector / LLM layer.
 */

// BM25 free parameters — the textbook defaults. k1 controls term-frequency
// saturation; b controls length normalisation.
const K1 = 1.2;
const B = 0.75;

// A filename hit is a strong signal ("find the note called X"). Each distinct
// query term present in the basename adds this much, set to roughly outweigh a
// single strong body hit so a clean title match leads — without burying a
// document that mentions every term in its body.
const NAME_BOOST = 2.0;

const SNIPPET_MAX = 200;
// Frontmatter kept per hit for its title and tags; a block past this is not a header.
const FRONTMATTER_MAX = 16_384;

/** A document to score: a root-relative path and its raw text. */
export interface SearchDoc {
  path: string;
  content: string;
  /** Absolute root the path is relative to, when the corpus spans several. */
  root?: string;
}

export interface SearchResult {
  /** Repo-relative path — what the desktop opens on click. */
  path: string;
  score: number;
  /** Distinct query terms found in the body. */
  body_hits: number;
  /** Distinct query terms found in the filename. */
  name_hits: number;
  /** Best-matching line (trimmed, truncated), or "" if matched on name only. */
  snippet: string;
  /** 1-based line number of `snippet`, or null when there's no body hit. */
  line: number | null;
}

/** A ranked hit with what the pass saw of its header, for titles and filters. */
export interface RankedHit extends SearchResult {
  root?: string;
  /** The raw leading `---` block, delimiters included, or null. */
  frontmatter: string | null;
  /** Text of the first `# ` heading, or null. */
  heading: string | null;
}

export interface RankOptions {
  limit?: number;
  /** Folded terms; a document containing any of them is dropped (it still counts in the corpus). */
  exclude?: string[];
  /**
   * Decides a document that hit (or, with no terms, every document). Called
   * once per candidate with its leading frontmatter block.
   */
  accept?: (doc: SearchDoc, frontmatter: string | null) => boolean;
  /** With no terms, return every accepted document at score 0 instead of nothing. */
  listWhenNoTerms?: boolean;
}

export interface RankOutcome {
  hits: RankedHit[];
  /** Documents read. */
  scanned: number;
  /** Documents that matched before the limit was applied. */
  matched: number;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const MARKS = /\p{M}+/gu;

/**
 * Fold for matching: compatibility-decompose, lowercase, drop combining marks.
 * `Pēteris` → `peteris`, `ﬁle` → `file`. Shared by terms, tags and authors.
 */
export function fold(text: string): string {
  if (ASCII_ONLY.test(text)) return text.toLowerCase();
  return text.normalize("NFKD").toLowerCase().replace(MARKS, "").normalize("NFC");
}

/**
 * Split text into folded letter/number terms. Punctuation breaks a token
 * (`multi-agent` → `multi`, `agent`), matching how the body is tokenised so a
 * query term lines up with body terms. Letters are Unicode (`\p{L}`): accents
 * fold away, so `Pēteris` and `peteris` are one term. No stemming (v1).
 */
export function tokenize(text: string): string[] {
  if (ASCII_ONLY.test(text)) return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Non-negative BM25 idf — the `ln(1 + …)` form, so common terms never go negative. */
function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

// Filename text for the name signal: basename without extension, so a query
// term matches `meeting-notes.md` via its tokens rather than the ".md".
function nameTokens(path: string): Set<string> {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return new Set(tokenize(base));
}

/** The leading frontmatter block, delimiters included, or null. */
export function leadingFrontmatter(lines: string[]): string | null {
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  let size = 0;
  for (let i = 1; i < lines.length; i++) {
    size += lines[i].length + 1;
    if (size > FRONTMATTER_MAX) return null;
    if (lines[i].replace(/\r$/, "") === "---") return lines.slice(0, i + 1).join("\n");
  }
  return null;
}

interface Hit {
  doc: SearchDoc;
  length: number;
  tf: Map<string, number>;
  nameHits: number;
  snippet: string;
  line: number | null;
  frontmatter: string | null;
  heading: string | null;
}

/**
 * Score `docs` against folded `terms`, returning the top `limit` by relevance.
 *
 * `docs` is consumed lazily — pass a generator to keep peak memory at one file.
 * A document surfaces if it contains any term in its body OR its filename;
 * the two signals add, so a pure title match still ranks.
 */
export function rankDocs(docs: Iterable<SearchDoc>, terms: string[], options: RankOptions = {}): RankOutcome {
  const limit = options.limit ?? 20;
  const unique = [...new Set(terms)];
  const termSet = new Set(unique);
  const excludeSet = new Set(options.exclude ?? []);
  const listAll = unique.length === 0 && options.listWhenNoTerms === true;
  if (unique.length === 0 && !listAll) return { hits: [], scanned: 0, matched: 0 };

  // Corpus-wide stats accumulated over every doc (matching or not), so avgdl and
  // df are exact. Only matching docs are retained.
  let n = 0;
  let totalLen = 0;
  const df = new Map<string, number>();
  const hits: Hit[] = [];

  for (const doc of docs) {
    n++;
    const lines = doc.content.split("\n");
    const tf = new Map<string, number>();
    let length = 0;
    let bestLine = "";
    let bestLineNo: number | null = null;
    let bestLineHits = 0;
    let excluded = false;
    let heading: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (heading === null && raw.startsWith("# ")) heading = raw.slice(2).trim() || null;
      const lineTokens = tokenize(raw);
      length += lineTokens.length;
      let lineHits = 0;
      for (const tok of lineTokens) {
        if (termSet.has(tok)) {
          tf.set(tok, (tf.get(tok) ?? 0) + 1);
          lineHits++;
        } else if (excludeSet.has(tok)) {
          excluded = true;
        }
      }
      // The line with the most query-term occurrences becomes the snippet.
      if (lineHits > bestLineHits) {
        bestLineHits = lineHits;
        bestLine = raw.trim();
        bestLineNo = i + 1;
      }
    }

    totalLen += length;
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

    const nameHitSet = nameTokens(doc.path);
    let nameHits = 0;
    for (const term of unique) if (nameHitSet.has(term)) nameHits++;

    if ((tf.size > 0 || nameHits > 0 || listAll) && !excluded) {
      const frontmatter = leadingFrontmatter(lines);
      if (options.accept && !options.accept(doc, frontmatter)) continue;
      const snippet =
        bestLine.length > SNIPPET_MAX ? `${bestLine.slice(0, SNIPPET_MAX - 1)}…` : bestLine;
      hits.push({ doc, length, tf, nameHits, snippet, line: bestLineNo, frontmatter, heading });
    }
  }

  if (n === 0) return { hits: [], scanned: 0, matched: 0 };
  const avgdl = totalLen / n || 1;

  const scored: RankedHit[] = hits.map((h) => {
    let bm25 = 0;
    for (const [term, freq] of h.tf) {
      const norm = freq + K1 * (1 - B + (B * h.length) / avgdl);
      bm25 += idf(n, df.get(term) ?? 0) * ((freq * (K1 + 1)) / norm);
    }
    return {
      path: h.doc.path,
      ...(h.doc.root !== undefined ? { root: h.doc.root } : {}),
      score: bm25 + h.nameHits * NAME_BOOST,
      body_hits: h.tf.size,
      name_hits: h.nameHits,
      snippet: h.snippet,
      line: h.line,
      frontmatter: h.frontmatter,
      heading: h.heading,
    };
  });

  // Highest score first; ties broken by root then path for a stable, deterministic order.
  scored.sort((a, b) => b.score - a.score || (a.root ?? "").localeCompare(b.root ?? "") || a.path.localeCompare(b.path));
  return { hits: scored.slice(0, Math.max(0, limit)), scanned: n, matched: scored.length };
}

/**
 * Score `docs` against `query`, returning the top `limit` by relevance — the
 * single-repo form, kept for callers that pass plain words.
 */
export function searchDocs(
  docs: Iterable<SearchDoc>,
  query: string,
  limit = 20,
): SearchResult[] {
  return rankDocs(docs, tokenize(query), { limit }).hits.map((hit) => ({
    path: hit.path,
    score: hit.score,
    body_hits: hit.body_hits,
    name_hits: hit.name_hits,
    snippet: hit.snippet,
    line: hit.line,
  }));
}
