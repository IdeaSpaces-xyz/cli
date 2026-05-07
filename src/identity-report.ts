import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { inspectMarkdownIdentity } from "@ideaspaces/sdk";

export interface IdentityFileStatus {
  path: string;
  status: "valid" | "missing" | "malformed";
  node_id: string | null;
  duplicate: boolean;
  message?: string;
}

export interface IdentityScanResult {
  files: IdentityFileStatus[];
  missing: IdentityFileStatus[];
  malformed: IdentityFileStatus[];
  duplicates: IdentityFileStatus[];
}

export async function scanMarkdownIdentityFiles(files: string[]): Promise<IdentityScanResult> {
  const statuses = await Promise.all(
    files.map(async (path): Promise<IdentityFileStatus> => {
      const content = await readFile(path, "utf-8");
      const identity = inspectMarkdownIdentity(content);
      return {
        path,
        status: identity.status,
        node_id: identity.node_id,
        duplicate: false,
        message: identity.message,
      };
    }),
  );

  const byId = new Map<string, IdentityFileStatus[]>();
  for (const status of statuses) {
    if (status.status !== "valid" || !status.node_id) continue;
    const group = byId.get(status.node_id) ?? [];
    group.push(status);
    byId.set(status.node_id, group);
  }

  const duplicates: IdentityFileStatus[] = [];
  for (const group of byId.values()) {
    if (group.length <= 1) continue;
    for (const item of group) {
      item.duplicate = true;
      duplicates.push(item);
    }
  }

  return {
    files: statuses,
    missing: statuses.filter((s) => s.status === "missing"),
    malformed: statuses.filter((s) => s.status === "malformed"),
    duplicates,
  };
}

export function hasIdentityProblems(scan: IdentityScanResult): boolean {
  return scan.missing.length > 0 || scan.malformed.length > 0 || scan.duplicates.length > 0;
}

export function renderIdentityProblems(
  scan: IdentityScanResult,
  opts: { cwd?: string; header?: string[]; footer?: string[] } = {},
): string {
  if (!hasIdentityProblems(scan)) return "";

  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [...(opts.header ?? [])];

  if (scan.missing.length) {
    lines.push(`Missing node_id (${scan.missing.length}):`);
    for (const item of scan.missing) lines.push(`  ${displayPath(cwd, item.path)}`);
  }
  if (scan.malformed.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`Malformed node_id (${scan.malformed.length}):`);
    for (const item of scan.malformed) {
      const suffix = item.message ? ` — ${item.message}` : "";
      lines.push(`  ${displayPath(cwd, item.path)}${suffix}`);
    }
  }
  if (scan.duplicates.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`Duplicate node_id (${scan.duplicates.length} files):`);
    const byId = new Map<string, IdentityFileStatus[]>();
    for (const item of scan.duplicates) {
      if (!item.node_id) continue;
      const group = byId.get(item.node_id) ?? [];
      group.push(item);
      byId.set(item.node_id, group);
    }
    for (const [id, group] of byId) {
      lines.push(`  ${id}`);
      for (const item of group) lines.push(`    ${displayPath(cwd, item.path)}`);
    }
  }

  if (opts.footer?.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...opts.footer);
  }
  return lines.join("\n");
}

function displayPath(cwd: string, path: string): string {
  return relative(cwd, path) || path;
}
