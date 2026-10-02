import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  inspectFrontmatterSyntax,
  parseFrontmatter,
  parseMap,
  stripFrontmatter,
  type MapBlock,
} from "@ideaspaces/protocol";

export interface LoadedMapNote {
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
    throw new Error(`Map note ${quoted(reference)} has no map block.`);
  }
  if (parsed.status === "invalid") {
    const issues = parsed.issues.map(({ path, code }) => `${path} (${code})`).join(", ");
    throw new Error(`Map note ${quoted(reference)} has an invalid map block: ${issues}`);
  }

  const name = scalar(frontmatter.name);
  const summary = scalar(frontmatter.summary);
  return {
    path: displayPath(absolutePath, resolve(contextRoot), reference),
    absolutePath,
    fileSha: createHash("sha256").update(content).digest("hex"),
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    legend: stripFrontmatter(content).trim(),
    map: parsed.map,
  };
}
