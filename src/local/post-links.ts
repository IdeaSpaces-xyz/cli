import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PostLinkReport {
  /** Links that cannot be right; the write is refused. */
  errors: string[];
  /** Links to a Thread post that does not exist yet, or a picture the app won't draw; the write goes ahead. */
  warnings: string[];
  /** Links into the Thread's _assets/ that aren't a real file there; refused even with --no-check-links. */
  refusals: string[];
}

export interface PostLinkOptions {
  /** --no-check-links: only the _assets/ rule runs, and a file that isn't there yet may land later. */
  assetsOnly?: boolean;
}

const ASSETS = "_assets";
const ASSETS_REFUSAL = "a file a post links to in _assets/ must be a real file in this Thread's _assets/, not a link, a folder or another spelling of _assets";
const PICTURE_ELSEWHERE = "the app draws pictures only from this Thread's _assets/; this one shows as its name.";

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const POST_FILE = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z-)?(.*-)?msg_[0-9a-f-]+\.md$/i;

/** Body text with fenced and inline code blanked, so example links in code are not checked. */
function withoutCode(body: string): string {
  return body
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** Inline Markdown link destinations: [text](dest) and [text](<dest with spaces> "title"); `picture` for ![text](dest). */
function destinations(text: string): Array<{ raw: string; picture: boolean }> {
  const found: Array<{ raw: string; picture: boolean }> = [];
  const pattern = /(!?)\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[2];
    found.push({ raw: raw.startsWith("<") ? raw.slice(1, -1) : raw, picture: match[1] === "!" });
  }
  return found;
}

/**
 * A link whose first step below the Thread is _assets, in any case: "ok" when every step is a real folder
 * or, last, a regular file, never a link, and its real path is inside the Thread's own _assets/; "missing"
 * when a step isn't there; else "refused".
 */
function assetsLink(realThread: string, steps: string[]): "ok" | "missing" | "refused" {
  if (steps[0] !== ASSETS) return "refused"; // _Assets/ finds the folder only on a case-insensitive disk
  let at = realThread;
  for (const [index, step] of steps.entries()) {
    at = join(at, step);
    let stat;
    try { stat = lstatSync(at); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "refused"; }
    if (stat.isSymbolicLink()) return "refused";
    if (index < steps.length - 1 ? !stat.isDirectory() : !stat.isFile()) return "refused";
  }
  const inside = relative(realpathSync(join(realThread, ASSETS)), realpathSync(at));
  return inside && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside) ? "ok" : "refused";
}

/**
 * Check the file-relative Markdown links in a post body before it is written.
 *
 * `postDir` is the directory the post file will live in; links resolve from there. Web links,
 * anchors and mail links are not paths and are skipped. A Map block's `position` values are
 * repository-relative, not file-relative, and are never read here: only the body is.
 *
 * Deliberately partial: only inline `[text](path)` links are checked; reference-style links and
 * autolinks are not. Both the Space root and the post directory are realpathed so a symlinked
 * checkout compares like with like; a symlink inside the Space that points out is not followed.
 */
export function checkPostLinks(body: string, postDir: string, spaceRoot: string, options: PostLinkOptions = {}): PostLinkReport {
  const report: PostLinkReport = { errors: [], warnings: [], refusals: [] };
  const realSpace = realpathSync(spaceRoot);
  const realPostDir = realpathSync(postDir);
  const seen = new Set<string>();
  for (const { raw, picture } of destinations(withoutCode(body))) {
    const key = `${picture ? "!" : ""}${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!raw || raw.startsWith("#") || raw.startsWith("//") || SCHEME.test(raw)) continue;
    const path = raw.split(/[?#]/)[0];
    if (!path) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { decoded = path; }
    if (isAbsolute(decoded) || decoded.includes("\\")) {
      if (options.assetsOnly) continue;
      report.errors.push(`${raw}: a link in a post is relative to the post file; an absolute or backslash path breaks on any other machine.`);
      continue;
    }
    const target = resolve(realPostDir, decoded);
    const inside = relative(realSpace, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      if (options.assetsOnly) continue;
      report.errors.push(`${raw}: resolves outside the Space (${target}). Links are relative to the post file, which sits in ${postDir}.`);
      continue;
    }
    // A link into this Thread's _assets/ is checked by what is on disk, not by its spelling: the writer
    // refuses what a reader that draws it would refuse.
    const steps = relative(realPostDir, target).split(sep);
    if (steps[0]?.toLowerCase() === ASSETS) {
      const verdict = assetsLink(realPostDir, steps);
      if (verdict === "refused") { report.refusals.push(`${raw}: ${ASSETS_REFUSAL}.`); continue; }
      if (verdict === "ok" || options.assetsOnly) continue;
    } else if (options.assetsOnly) continue;
    if (existsSync(target)) {
      if (picture && steps[0] !== ASSETS) report.warnings.push(`${raw}: ${PICTURE_ELSEWHERE}`);
      continue;
    }
    // A forward reference is a post-shaped filename in a Thread directory that exists.
    const name = target.split(sep).pop() ?? "";
    if (POST_FILE.test(name) && existsSync(dirname(target)) && /(^|[\\/])_threads[\\/][^\\/]+$/.test(dirname(target))) {
      report.warnings.push(`${raw}: no such post yet. Written anyway as a forward reference; check the filename if the post already exists.`);
      continue;
    }
    report.errors.push(`${raw}: no file at ${target}. Links are relative to the post file, which sits in ${postDir}.`);
  }
  return report;
}
