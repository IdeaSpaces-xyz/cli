import { existsSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot } from "../git.js";
import { emptyWorkspaceSurface, type KeeperWorkspaceSurface, type ToolInvocation } from "@ideaspaces/sdk";

export interface LocalFileCoordinate { root: string; path: string; root_kind: "repo" | "folder" }
export interface LocalWorkspaceSurface extends KeeperWorkspaceSurface {
  /** Absolute identity → portable path inside its owning local repo/folder. */
  file_coordinates: Record<string, LocalFileCoordinate>;
}

const MODIFIED_TOOLS = new Set(["write", "edit", "is_write", "is_commit"]);
const READ_TOOLS = new Set([
  "read",
  "is_inspect",
  "is_look",
  "is_navigate",
  "is_mount",
  "is_unmount",
  "is_status",
  "is_release",
  "is_explore",
  "is_get",
  "is_search",
  "ls",
  "glob",
  "grep",
  "find",
]);

const EXPLORATION_FALLBACK_TOOLS = new Set([
  "is_navigate",
  "ls",
]);

/** Resolve at the tool boundary, while cwd is still known. Navigation changes
 * awareness, not native tool cwd. Never interpret arbitrary shell commands. */
export function harvestLocalFiles(
  tools: ToolInvocation[],
  launchCwd: string,
  workingRoot: string = launchCwd,
): LocalWorkspaceSurface {
  const ws: LocalWorkspaceSurface = { ...emptyWorkspaceSurface(), file_coordinates: {} };
  const roots = new Map<string, { root: string; root_kind: "repo" | "folder" }>();
  const knownFolderRoots = [...new Set([workingRoot, launchCwd].map((root) => {
    try { return realpathSync.native(root); } catch { return resolve(root); }
  }))];
  const contains = (root: string, target: string): boolean => {
    const path = relative(root, target);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  for (const tool of tools) {
    if (tool.isError) continue;
    const knowledgeTool = tool.name.startsWith("is_");
    let cwd = launchCwd;
    if (knowledgeTool && typeof tool.args.cwd === "string" && tool.args.cwd.trim() !== "") {
      cwd = resolve(launchCwd, tool.args.cwd);
    } else if (knowledgeTool && typeof tool.args.root === "string" && tool.args.root.trim() !== "" && tool.args.root !== "home") {
      // In pi is_look/is_navigate, `root` names the target mount frame. "home" means authority
      // root (launchCwd); any other string is a mounted repo path or basename to resolve under.
      cwd = isAbsolute(tool.args.root) ? resolve(tool.args.root) : resolve(launchCwd, tool.args.root);
    }
    const kind = MODIFIED_TOOLS.has(tool.name) ? "modified"
      : READ_TOOLS.has(tool.name) ? "read" : undefined;
    if (!kind) continue;
    let paths: unknown[];
    const hasExplicitPath = typeof tool.args.path === "string" && tool.args.path.trim() !== "";
    if (tool.name === "is_commit" && Array.isArray(tool.args.paths)) {
      paths = tool.args.paths;
    } else if (tool.name === "is_get") {
      // is_get targets `dir`, `path`, or local `address` (remote URLs fail statSync and are skipped)
      paths = [tool.args.dir, tool.args.path, tool.args.address];
    } else if (hasExplicitPath) {
      paths = [tool.args.path];
    } else if (EXPLORATION_FALLBACK_TOOLS.has(tool.name)) {
      paths = ["."];
    } else {
      paths = [];
    }
    for (const input of paths) {
      if (typeof input !== "string" || !input || /[\x00-\x1f]/u.test(input)) continue;
      let absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
      let present = true;
      let isDir = false;
      try {
        const stat = statSync(absolute);
        if (stat.isFile()) {
          isDir = false;
        } else if (stat.isDirectory() && kind === "read") {
          // Directories are allowed only for read/exploration tools; mutations track files.
          isDir = true;
        } else {
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
        else continue;
      }
      // A commit or file edit may stage removals. Classify the current file state
      // rather than reporting a disappeared source path as an edited Note, while
      // skipping non-existent read/exploration targets.
      if (!present && kind === "read") continue;
      let ancestor = present ? absolute : dirname(absolute);
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      try { absolute = resolve(realpathSync.native(ancestor), relative(ancestor, absolute)); }
      catch { continue; }
      const bucket = present ? kind : "deleted";
      if (!ws[bucket].includes(absolute)) ws[bucket].push(absolute);
      let directory = isDir ? absolute : dirname(absolute);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      let scope = roots.get(directory);
      if (!scope) {
        try { scope = { root: repoRoot(directory), root_kind: "repo" }; }
        catch {
          let explicitRoot: string | undefined;
          if (knowledgeTool && typeof tool.args.cwd === "string") {
            try { explicitRoot = realpathSync.native(cwd); } catch { /* unavailable cwd */ }
          }
          const folderRoot = [...knownFolderRoots, ...(explicitRoot ? [explicitRoot] : [])]
            .find((root) => contains(root, absolute));
          scope = { root: folderRoot ?? directory, root_kind: "folder" };
        }
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
