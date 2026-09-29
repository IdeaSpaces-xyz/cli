import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

/** Lexical containment of already resolved paths, including Windows drives. */
export function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Was this path entered through the selected POV, even through an aliased ancestor? */
export function enteredThroughRoot(root: string, path: string): boolean {
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    try {
      if (realpathSync(ancestor) === root) return true;
    } catch { /* An unreadable ancestor grants no authority. */ }
    if (dirname(ancestor) === ancestor) return false;
  }
}
