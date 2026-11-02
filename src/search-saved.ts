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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

/** One line of title text: a --name with newlines or runs of spaces becomes one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describeQuery(search: SavedSearch): string {
  const lines = [
    `- **Query:** \`${search.query.replace(/`/g, "'")}\``,
    `- **Roots:** ${search.roots.map((r) => `\`${r}\``).join(", ")}`,
    `- **Threads:** ${search.threads ? "included" : "left out"}`,
  ];
  if (search.limit !== undefined) lines.push(`- **Limit:** ${search.limit}`);
  return lines.join("\n");
}

/** Write a saved-search Note. Refuses to replace an existing file unless `force`. */
export function writeSavedSearch(
  notePath: string,
  options: { name: string; summary?: string; query: string; roots: string[]; threads: boolean; limit?: number; force?: boolean },
): SavedSearchNote {
  const path = resolve(notePath);
  if (!path.endsWith(".md")) throw new SavedSearchError(`A saved search is a Note: give a path ending in .md (for example ${notePath}.search.md).`);
  if (existsSync(path)) {
    if (!options.force) throw new SavedSearchError(`${notePath} already exists. Choose another name, or pass --force to replace it.`);
    // --force replaces a saved search, never an ordinary Note that happens to share the name.
    try {
      readSavedSearch(path);
    } catch {
      throw new SavedSearchError(`${notePath} is a Note that is not a saved search; --force only replaces saved searches. Choose another name.`);
    }
  }
  const name = oneLine(options.name);
  if (!name) throw new SavedSearchError("--name needs text.");
  const dir = dirname(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new SavedSearchError(`No such folder for the saved search: ${dirname(notePath)}`);
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
    `Open it with \`ideaspaces search --open ${toPosix(relative(process.cwd(), path)) || path}\`.`,
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
