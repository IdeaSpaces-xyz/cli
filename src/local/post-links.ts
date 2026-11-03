import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface PostLinkReport {
  /** Links that cannot be right; the write is refused. */
  errors: string[];
  /** Links to a Thread post that does not exist yet; the write goes ahead. */
  warnings: string[];
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const POST_FILE = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z-)?(.*-)?msg_[0-9a-f-]+\.md$/i;

/** Body text with fenced and inline code blanked, so example links in code are not checked. */
function withoutCode(body: string): string {
  return body
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** Inline Markdown link destinations: [text](dest) and [text](<dest with spaces> "title"). Images included. */
function destinations(text: string): string[] {
  const found: string[] = [];
  const pattern = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    found.push(raw.startsWith("<") ? raw.slice(1, -1) : raw);
  }
  return found;
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
export function checkPostLinks(body: string, postDir: string, spaceRoot: string): PostLinkReport {
  const report: PostLinkReport = { errors: [], warnings: [] };
  const realSpace = realpathSync(spaceRoot);
  const realPostDir = realpathSync(postDir);
  const seen = new Set<string>();
  for (const raw of destinations(withoutCode(body))) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!raw || raw.startsWith("#") || raw.startsWith("//") || SCHEME.test(raw)) continue;
    const path = raw.split(/[?#]/)[0];
    if (!path) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { decoded = path; }
    if (isAbsolute(decoded) || decoded.includes("\\")) {
      report.errors.push(`${raw}: a link in a post is relative to the post file; an absolute or backslash path breaks on any other machine.`);
      continue;
    }
    const target = resolve(realPostDir, decoded);
    const inside = relative(realSpace, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      report.errors.push(`${raw}: resolves outside the Space (${target}). Links are relative to the post file, which sits in ${postDir}.`);
      continue;
    }
    if (existsSync(target)) continue;
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
