import { homedir } from "node:os";
import { join } from "node:path";

/** Shells expand ~ only at the beginning of an argument, not after commas. */
export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
