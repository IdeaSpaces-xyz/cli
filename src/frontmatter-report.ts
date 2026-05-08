import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { inspectFrontmatterSyntax } from "@ideaspaces/sdk";

export interface FrontmatterSyntaxFileStatus {
  path: string;
  status: "none" | "valid" | "malformed";
  message?: string;
  line?: number;
  column?: number;
}

export interface FrontmatterSyntaxScanResult {
  files: FrontmatterSyntaxFileStatus[];
  malformed: FrontmatterSyntaxFileStatus[];
}

export async function scanMarkdownFrontmatterSyntaxFiles(
  files: string[],
): Promise<FrontmatterSyntaxScanResult> {
  const statuses = await Promise.all(
    files.map(async (path): Promise<FrontmatterSyntaxFileStatus> => {
      const content = await readFile(path, "utf-8");
      return { path, ...inspectFrontmatterSyntax(content) };
    }),
  );

  return {
    files: statuses,
    malformed: statuses.filter((s) => s.status === "malformed"),
  };
}

export function hasFrontmatterSyntaxProblems(scan: FrontmatterSyntaxScanResult): boolean {
  return scan.malformed.length > 0;
}

export function renderFrontmatterSyntaxProblems(
  scan: FrontmatterSyntaxScanResult,
  opts: { cwd?: string; header?: string[]; footer?: string[] } = {},
): string {
  if (!hasFrontmatterSyntaxProblems(scan)) return "";

  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [];
  if (opts.header?.length) lines.push(...opts.header);

  lines.push(`Malformed frontmatter (${scan.malformed.length}):`);
  for (const item of scan.malformed) {
    const loc = item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : "";
    lines.push(`  ${relative(cwd, item.path) || item.path}${loc}`);
    if (item.message) lines.push(`    ${item.message}`);
  }

  if (opts.footer?.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...opts.footer);
  }
  return lines.join("\n");
}
