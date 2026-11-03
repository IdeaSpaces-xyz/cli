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
 * again over what is on disk now: the same files give the same results. A
 * hand-written Note may name an absolute root; it is honoured, but is not
 * portable.
 *
 * The CLI owns this `search:` shape until the protocol adopts it; then the
 * validation in readSavedSearch moves there.
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

const MAX_NOTE_BYTES = 64 * 1024;
/** The largest existing file `--force` reads to see whether it is a saved search. */
const MAX_CHECK_BYTES = 4 * 1024 * 1024;

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
  const dir = dirname(path);
  const roots = (rootsValue as string[]).map((r) => r.trim());
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
    absoluteRoots: roots.map((r) => (isAbsolute(r) ? r : resolve(dir, r))),
  };
}
