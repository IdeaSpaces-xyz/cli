import { isAbsolute, relative, sep } from "node:path";

/** Lexical containment of already resolved paths, including Windows drives. */
export function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
