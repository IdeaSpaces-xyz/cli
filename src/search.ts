/**
 * Local, repo-level full-text search — pure BM25 over Markdown, plus a filename
 * signal. No index, no native deps, no network: the corpus is the files already
 * on disk, scored in a single streaming pass.
 *
 * Why streaming, not an in-memory inverted index: this runs as a short-lived
 * verb (CLI invoke → answer → exit, or one sidecar call per desktop search).
 * We only care about the query's terms, so we never materialise the full corpus
 * — {@link searchDocs} consumes a *lazy* iterable, holding one document at a
 * time and retaining only the docs that actually hit. Peak memory scales with
 * the largest single file + the number of matches, not the repo size.
 *
 * Deferred (qmd has these; out of scope for v1): a persisted/incremental index,
 * porter stemming, phrase/negation query syntax, and any vector / LLM layer.
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

/** A document to score: a repo-relative path and its raw text. */
export interface SearchDoc {
  path: string;
  content: string;
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

/**
 * Split text into lowercased alphanumeric terms. Hyphenated/punctuated tokens
 * break apart (`multi-agent` → `multi`, `agent`), matching how the body is
 * tokenised so a query term lines up with body terms. No stemming (v1).
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
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

interface Hit {
  path: string;
  length: number;
  tf: Map<string, number>;
  nameHits: number;
  snippet: string;
  line: number | null;
}

/**
 * Score `docs` against `query`, returning the top `limit` by relevance.
 *
 * `docs` is consumed lazily — pass a generator to keep peak memory at one file.
 * A document surfaces if it contains any query term in its body OR its filename;
 * the two signals add, so a pure title match still ranks.
 */
export function searchDocs(
  docs: Iterable<SearchDoc>,
  query: string,
  limit = 20,
): SearchResult[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const termSet = new Set(terms);

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

    for (let i = 0; i < lines.length; i++) {
      const lineTokens = tokenize(lines[i]);
      length += lineTokens.length;
      let lineHits = 0;
      for (const tok of lineTokens) {
        if (termSet.has(tok)) {
          tf.set(tok, (tf.get(tok) ?? 0) + 1);
          lineHits++;
        }
      }
      // The line with the most query-term occurrences becomes the snippet.
      if (lineHits > bestLineHits) {
        bestLineHits = lineHits;
        bestLine = lines[i].trim();
        bestLineNo = i + 1;
      }
    }

    totalLen += length;
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

    const nameHitSet = nameTokens(doc.path);
    let nameHits = 0;
    for (const term of terms) if (nameHitSet.has(term)) nameHits++;

    if (tf.size > 0 || nameHits > 0) {
      const snippet =
        bestLine.length > SNIPPET_MAX ? `${bestLine.slice(0, SNIPPET_MAX - 1)}…` : bestLine;
      hits.push({ path: doc.path, length, tf, nameHits, snippet, line: bestLineNo });
    }
  }

  if (n === 0) return [];
  const avgdl = totalLen / n || 1;

  const scored: SearchResult[] = hits.map((h) => {
    let bm25 = 0;
    for (const [term, freq] of h.tf) {
      const norm = freq + K1 * (1 - B + (B * h.length) / avgdl);
      bm25 += idf(n, df.get(term) ?? 0) * ((freq * (K1 + 1)) / norm);
    }
    return {
      path: h.path,
      score: bm25 + h.nameHits * NAME_BOOST,
      body_hits: h.tf.size,
      name_hits: h.nameHits,
      snippet: h.snippet,
      line: h.line,
    };
  });

  // Highest score first; ties broken by path for a stable, deterministic order.
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(0, limit));
}
