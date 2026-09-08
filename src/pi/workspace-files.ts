import { existsSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { repoRoot } from "../git.js";
import { emptyWorkspaceSurface, type KeeperWorkspaceSurface, type ToolInvocation } from "@ideaspaces/sdk";

export interface LocalFileCoordinate { root: string; path: string; root_kind: "repo" | "folder" }
export interface LocalWorkspaceSurface extends KeeperWorkspaceSurface {
  /** Absolute identity → portable path inside its owning local repo/folder. */
  file_coordinates: Record<string, LocalFileCoordinate>;
}

/** Resolve at the tool boundary, while cwd is still known. Navigation changes
 * awareness, not native tool cwd. Never interpret arbitrary shell commands. */
export function harvestLocalFiles(tools: ToolInvocation[], launchCwd: string): LocalWorkspaceSurface {
  const ws: LocalWorkspaceSurface = { ...emptyWorkspaceSurface(), file_coordinates: {} };
  const roots = new Map<string, { root: string; root_kind: "repo" | "folder" }>();
  for (const tool of tools) {
    if (tool.isError) continue;
    const knowledgeTool = ["is_write", "is_commit", "is_inspect"].includes(tool.name);
    const cwd = knowledgeTool && typeof tool.args.cwd === "string" ? resolve(launchCwd, tool.args.cwd) : launchCwd;
    const kind = ["write", "edit", "is_write", "is_commit"].includes(tool.name) ? "modified"
      : ["read", "is_inspect"].includes(tool.name) ? "read" : undefined;
    if (!kind) continue;
    const paths = tool.name === "is_commit" && Array.isArray(tool.args.paths) ? tool.args.paths : [tool.args.path];
    for (const input of paths) {
      if (typeof input !== "string" || !input || /[\x00-\x1f]/u.test(input)) continue;
      let absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
      // A commit may stage removals. Classify the current file state rather than
      // reporting a disappeared source path as an edited Note.
      let present = true;
      try { if (!statSync(absolute).isFile()) continue; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
        else throw error;
      }
      let ancestor = present ? absolute : dirname(absolute);
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      absolute = resolve(realpathSync.native(ancestor), relative(ancestor, absolute));
      const bucket = present ? kind : "deleted";
      if (!ws[bucket].includes(absolute)) ws[bucket].push(absolute);
      let directory = dirname(absolute);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      let scope = roots.get(directory);
      if (!scope) {
        try { scope = { root: repoRoot(directory), root_kind: "repo" }; }
        catch { scope = { root: directory, root_kind: "folder" }; }
        roots.set(directory, scope);
      }
      ws.file_coordinates[absolute] = { ...scope, path: relative(scope.root, absolute).split("\\").join("/") };
    }
  }
  // Last on-disk state wins when a turn touched a file before removing it.
  const deleted = new Set(ws.deleted);
  ws.read = ws.read.filter((path) => !deleted.has(path));
  ws.modified = ws.modified.filter((path) => !deleted.has(path));
  return ws;
}
