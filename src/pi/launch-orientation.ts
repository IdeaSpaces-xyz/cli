import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Host-selected working coordinates, not user-message text or a reference mount.
 * Resolve only explicitly supplied local paths; never fetch or read their content. */
export function localLaunchOrientation(
  povRoot: string,
  workingRoot: string,
  focus: string = "",
): string {
  if (!workingRoot.trim() || !isAbsolute(workingRoot)) throw new Error("--working-root must be an absolute local directory");
  if ([povRoot, workingRoot, focus].some((value) => value.includes("\0") || /[\r\n]/u.test(value))) {
    throw new Error("Launch coordinates must not contain control characters");
  }
  if (isAbsolute(focus) || focus.split(/[\\/]/u).includes("..")) {
    throw new Error("--focus must be a path inside --working-root");
  }
  const working = realpathSync(workingRoot);
  if (!statSync(working).isDirectory()) throw new Error("--working-root must be a directory");
  const target = realpathSync(resolve(working, focus || "."));
  const position = relative(working, target);
  if (isAbsolute(position) || position === ".." || position.startsWith(`..${sep}`)) {
    throw new Error("--focus resolves outside --working-root");
  }
  return "[Local session position]\n" + JSON.stringify({
    povRoot: realpathSync(povRoot), workingRoot: working, focus: position.split(sep).join("/"),
  }) + "\nThe launch folder supplies the chosen POV. The workingRoot is the material to work on, " +
    "not a read-only reference mount. Orient there without replacing the chosen POV. " +
    "Focus is relative to workingRoot (empty means the folder itself). Inspect the selected material " +
    "before answering; use absolute paths for tools. File @mentions in the user question are relative to workingRoot. " +
    "These coordinates do not grant additional OS permissions or request changes to the POV folder.";
}
