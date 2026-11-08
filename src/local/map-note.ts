import { createHash } from "node:crypto";
import { readFileSync, promises as fs, type BigIntStats } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  inspectFrontmatterSyntax,
  parseFrontmatter,
  parseMap,
  stripFrontmatter,
  type MapBlock,
} from "@ideaspaces/protocol";

export interface LoadedMapNote {
  /** Exact validated bytes, for explicit portable-copy uploads. Never resolve a second read. */
  content: string;
  /** For display: relative to the context it was loaded from when inside it. */
  path: string;
  /** Where the note is on disk; a Map's roots are looked for from its folder. */
  absolutePath: string;
  fileSha: string;
  name?: string;
  summary?: string;
  legend: string;
  map: MapBlock;
}

/** The note is a valid file with frontmatter but carries no `map:` block. Callers tell it from an unreadable or invalid Map by type, not by wording. */
export class NoMapBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMapBlockError";
  }
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function displayPath(absolutePath: string, contextRoot: string, reference: string): string {
  const local = relative(contextRoot, absolutePath);
  const outside = local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local);
  return local && !outside ? local : reference;
}

/** Read and validate one file-first Map without resolving or fetching any root. */
export function loadMapNote(reference: string, contextRoot: string): LoadedMapNote {
  const absolutePath = resolve(contextRoot, reference);
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read map note ${quoted(reference)}: ${detail}`);
  }

  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status === "none") {
    throw new Error(`Map note ${quoted(reference)} has no frontmatter.`);
  }
  if (syntax.status === "malformed") {
    const where = syntax.line === undefined
      ? ""
      : ` at line ${syntax.line}${syntax.column === undefined ? "" : `, column ${syntax.column}`}`;
    throw new Error(`Map note ${quoted(reference)} has malformed frontmatter${where}: ${syntax.message}`);
  }

  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    throw new Error(`Map note ${quoted(reference)} must have object frontmatter.`);
  }
  const parsed = parseMap(frontmatter.map);
  if (parsed.status === "absent") {
    throw new NoMapBlockError(`Map note ${quoted(reference)} has no map block.`);
  }
  if (parsed.status === "invalid") {
    const issues = parsed.issues.map(({ path, code }) => `${path} (${code})`).join(", ");
    throw new Error(`Map note ${quoted(reference)} has an invalid map block: ${issues}`);
  }

  const name = scalar(frontmatter.name);
  const summary = scalar(frontmatter.summary);
  return {
    content,
    path: displayPath(absolutePath, resolve(contextRoot), reference),
    absolutePath,
    fileSha: createHash("sha256").update(content).digest("hex"),
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    legend: stripFrontmatter(content).trim(),
    map: parsed.map,
  };
}

/** The shared local Map create boundary: validate first, never replace an existing path. */
export async function writeNewMapNote(reference: string, content: string): Promise<{ path: string; sha: string }> {
  const path = resolve(reference);
  if (basename(path) !== "README.md" && !basename(path).endsWith(".map.md")) {
    throw new Error("A local Map needs a *.map.md or README.md path.");
  }
  if (typeof content !== "string") throw new Error("No readable Map document was returned; nothing was written.");
  const syntax = inspectFrontmatterSyntax(content);
  const frontmatter = parseFrontmatter(content);
  if (syntax.status !== "valid" || !frontmatter || parseMap(frontmatter.map).status !== "valid") {
    throw new Error("The document is not a valid Map note; nothing was written.");
  }
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  let owned: BigIntStats | undefined;
  try {
    file = await fs.open(path, "wx");
    owned = await file.stat({ bigint: true });
    await file.writeFile(content);
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close().catch(() => {});
    // Remove only our failed creation, never a path another writer has replaced.
    if (owned && owned.ino !== 0n) {
      const current = await fs.lstat(path, { bigint: true }).catch(() => undefined);
      if (current && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
        await fs.unlink(path).catch(() => {});
      }
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw Object.assign(new Error(`Local Map already exists: ${path}. Choose a new path; existing files are never replaced.`), { code });
    if (code === "ENOENT") throw Object.assign(new Error(`The destination folder does not exist: ${path}. Create the folder first; nothing was written.`), { code });
    throw error;
  }
  return { path, sha: createHash("sha256").update(content).digest("hex") };
}
