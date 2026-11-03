/**
 * A saved search: an ordinary Note whose frontmatter carries the query.
 *
 *   ---
 *   name: Desktop frictions
 *   summary: Every friction post about Desktop.
 *   search:
 *     query: desktop tag:friction
 *     roots: [".", agents/scout]     # folders, relative to this Note's folder
 *     threads: true
 *   ---
 *
 * It is a Note, so it can be read, committed, linked and named in a Map like
 * any other; readers that do not know `search` ignore it. Roots are stored
 * relative to the Note, never as machine paths, so the same Note opens the
 * same folders on another checkout of the same tree. Opening it runs the query
 * again over what is on disk now: the same files give the same results.
 *
 * A saved search can only look inside its own Vault: every root, after
 * symlinks, must lie within the boundary of the Note (see {@link searchBoundary}).
 * A Note from a clone or from someone else therefore cannot make `--open`
 * read `/`, a home folder, or any folder outside the tree it was saved in.
 * `--save` refuses such a root too, so whatever is saved can be opened.
 *
 * The CLI owns this `search:` shape until the protocol adopts it; then the
 * validation in readSavedSearch moves there. Tracking:
 * https://github.com/IdeaSpaces-xyz/ideaspace-protocol/issues/85
 */

import { parseFrontmatter } from "@ideaspaces/protocol";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";

export interface SavedSearch {
  query: string;
  /** Folders as stored: relative to the Note's folder, POSIX separators. */
  roots: string[];
  threads: boolean;
  limit?: number;
}

export interface SavedSearchNote {
  /** Absolute path of the Note. */
  path: string;
  name: string;
  summary: string | null;
  search: SavedSearch;
  /** Roots resolved to absolute folders. */
  absoluteRoots: string[];
}

export class SavedSearchError extends Error {}

/** A saved search is a few lines of frontmatter; a Note this large is not one. */
const MAX_NOTE_BYTES = 64 * 1024;
/** The most `--force` reads of an existing file to see whether it is a saved search (any Note is read as large as search itself reads one). */
const MAX_CHECK_BYTES = 4 * 1024 * 1024;

/**
 * The folder a saved search may not look beyond: the Vault the Note lives in
 * (the nearest ancestor holding `home.map.md`), else its enclosing Git
 * repository, else the Note's own folder. `dir` is the Note's canonical folder.
 */
export function searchBoundary(dir: string): string {
  let repo: string | null = null;
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(resolve(at, "home.map.md"))) return at;
    if (repo === null && existsSync(resolve(at, ".git"))) repo = at;
    if (dirname(at) === at) break;
  }
  return repo ?? dir;
}

function within(boundary: string, path: string): boolean {
  const rel = relative(boundary, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A root's real location: its realpath when it exists, else the path as resolved. */
function realRoot(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Refuse a root that resolves outside the boundary, naming it and the boundary. */
function checkInside(boundary: string, root: string, what: string): void {
  if (!within(boundary, realRoot(root))) {
    throw new SavedSearchError(
      `${what} ${root} lies outside the Vault this saved search belongs to (${boundary}). A saved search only looks inside its own Vault; save it in a folder that contains what it searches.`,
    );
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * A root as the Note stores it: relative to the Note's folder, `.` for the
 * folder itself. A root that has no relative path from the Note (another
 * drive on Windows) is refused rather than stored as a machine path.
 */
export function storedRoot(noteDir: string, root: string): string {
  const rel = relative(noteDir, root);
  if (isAbsolute(rel)) {
    throw new SavedSearchError(`${root} has no path relative to the Note's folder (another drive?). Save the Note on the same drive as the folders it searches.`);
  }
  const posix = toPosix(rel);
  return posix === "" ? "." : posix;
}

/** A path as one shell word: bare when it is plain, single-quoted otherwise. */
export function shellWord(text: string): string {
  return /^[\w./@:+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** One line of title text: a --name with newlines or runs of spaces becomes one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describeQuery(search: SavedSearch): string {
  const lines = [
    `- **Query:** \`${oneLine(search.query).replace(/`/g, "'")}\``,
    `- **Roots:** ${search.roots.map((r) => `\`${r}\``).join(", ")}`,
    `- **Threads:** ${search.threads ? "included" : "left out"}`,
  ];
  if (search.limit !== undefined) lines.push(`- **Limit:** ${search.limit}`);
  return lines.join("\n");
}

/** Whether an existing file is a saved search: its frontmatter has a `search:` block. */
function existingIsSavedSearch(path: string, notePath: string): boolean {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new SavedSearchError(`Cannot check ${notePath} before replacing it: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (!stat.isFile()) throw new SavedSearchError(`${notePath} is not a file, so --force will not replace it.`);
  if (stat.size > MAX_CHECK_BYTES) throw new SavedSearchError(`${notePath} is too large to check before replacing it; choose another name.`);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new SavedSearchError(`Cannot read ${notePath} before replacing it: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  const block = parseFrontmatter(content)?.search;
  return !!block && typeof block === "object" && !Array.isArray(block);
}

/**
 * Check where a saved search would be written, before any search runs: a `.md` path in an
 * existing folder, and no existing file unless `force` and that file is a saved search.
 * Returns the absolute path and the Note's canonical folder.
 */
export function checkSaveTarget(notePath: string, force: boolean): { path: string; dir: string } {
  const path = resolve(notePath);
  if (!path.endsWith(".md")) throw new SavedSearchError(`A saved search is a Note: give a path ending in .md (for example ${notePath}.search.md).`);
  let dir: string;
  try {
    dir = realpathSync(dirname(path));
    if (!statSync(dir).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new SavedSearchError(`No such folder for the saved search: ${dirname(notePath)}`);
  }
  if (existsSync(path)) {
    if (!force) throw new SavedSearchError(`${notePath} already exists. Choose another name, or pass --force to replace it.`);
    // --force replaces a saved search, never an ordinary Note that happens to share the name.
    if (!existingIsSavedSearch(path, notePath)) {
      throw new SavedSearchError(`${notePath} is a Note that is not a saved search; --force only replaces saved searches. Choose another name.`);
    }
  }
  return { path, dir };
}

/** Write a saved-search Note. Refuses to replace an existing file unless `force`. */
export function writeSavedSearch(
  notePath: string,
  options: { name: string; summary?: string; query: string; roots: string[]; threads: boolean; limit?: number; force?: boolean },
): SavedSearchNote {
  const { path, dir } = checkSaveTarget(notePath, options.force === true);
  const name = oneLine(options.name);
  if (!name) throw new SavedSearchError("--name needs text.");
  // Whatever is saved must open again: refuse a root --open would refuse.
  const boundary = searchBoundary(dir);
  for (const root of options.roots) checkInside(boundary, root, "The folder");
  const search: SavedSearch = {
    query: options.query,
    roots: options.roots.map((root) => storedRoot(dir, root)),
    threads: options.threads,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  };
  const frontmatter: Record<string, unknown> = { name };
  if (options.summary) frontmatter.summary = options.summary;
  frontmatter.search = search;
  const body = [
    `# ${name}`,
    "",
    "A saved search. It runs again over what is on disk when opened:",
    "",
    describeQuery(search),
    "",
    // No machine or working-directory path: the Note reads the same wherever it is opened.
    `Open it again with \`ideaspaces search --open ${shellWord(basename(path))}\` from this folder, or give its path from anywhere.`,
    "",
  ].join("\n");
  writeFileSync(path, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, { flag: options.force ? "w" : "wx" });
  return { path, name, summary: options.summary ?? null, search, absoluteRoots: options.roots };
}

/** Read and check a saved-search Note; every refusal says what is wrong and where. */
export function readSavedSearch(notePath: string): SavedSearchNote {
  const path = resolve(notePath);
  let content: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new SavedSearchError(`Not a file: ${notePath}`);
    if (stat.size > MAX_NOTE_BYTES) throw new SavedSearchError(`${notePath} is too large to be a saved search.`);
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof SavedSearchError) throw error;
    throw new SavedSearchError(`Cannot read saved search ${notePath}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  const fm = parseFrontmatter(content);
  if (!fm) throw new SavedSearchError(`${notePath} has no readable frontmatter, so it is not a saved search.`);
  const raw = fm.search;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SavedSearchError(`${notePath} has no search: block in its frontmatter, so it is not a saved search.`);
  }
  const block = raw as Record<string, unknown>;
  if (typeof block.query !== "string" || !block.query.trim()) {
    throw new SavedSearchError(`${notePath}: search.query must be the query text.`);
  }
  const rootsValue = block.roots ?? ["."];
  if (!Array.isArray(rootsValue) || rootsValue.length === 0 || !rootsValue.every((r) => typeof r === "string" && r.trim())) {
    throw new SavedSearchError(`${notePath}: search.roots must be a list of folders relative to the Note.`);
  }
  if (block.threads !== undefined && typeof block.threads !== "boolean") {
    throw new SavedSearchError(`${notePath}: search.threads must be true or false.`);
  }
  if (block.limit !== undefined && !(Number.isInteger(block.limit) && (block.limit as number) > 0)) {
    throw new SavedSearchError(`${notePath}: search.limit must be a whole number, 1 or more.`);
  }
  // Roots were stored relative to the Note's canonical folder, so they resolve from it too:
  // opening through a symlinked folder must reach the same roots as saving through it.
  let dir: string;
  try { dir = realpathSync(dirname(path)); } catch { dir = dirname(path); }
  const roots = (rootsValue as string[]).map((r) => r.trim());
  const absoluteRoots = roots.map((r) => (isAbsolute(r) ? r : resolve(dir, r)));
  const boundary = searchBoundary(dir);
  roots.forEach((stored, i) => checkInside(boundary, absoluteRoots[i], `${notePath}: search.roots entry '${stored}' resolves to`));
  return {
    path,
    name: typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : relative(dir, path),
    summary: typeof fm.summary === "string" ? fm.summary : null,
    search: {
      query: block.query.trim(),
      roots,
      threads: block.threads === true,
      ...(block.limit !== undefined ? { limit: block.limit as number } : {}),
    },
    absoluteRoots,
  };
}
