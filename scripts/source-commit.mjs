import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SHA = /^[a-f0-9]{40}$/;

/**
 * The last commit that touched the CLI's sources, for the catalog's provenance.
 * With full history it is read from Git. Without it, either because the build runs in a copy that
 * has no `.git` (npm builds a `github:` dependency that way) or in a shallow clone (where the
 * newest commit would be read instead), the committed catalog's own record is kept, as long as it
 * is for this version. A build with neither stops and says so.
 */
export function sourceCommit(sourcePaths, { version, run = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), recordedPath = "bundle/agent-tools.json" } = {}) {
  try {
    if (run(["rev-parse", "--is-shallow-repository"]) === "false") {
      const commit = run(["log", "-1", "--format=%H", "--", ...sourcePaths]);
      if (SHA.test(commit)) return commit;
    }
  } catch { /* no usable history: fall through to the committed record */ }
  try {
    const recorded = JSON.parse(readFileSync(recordedPath, "utf8")).cli;
    if (recorded?.version === version && SHA.test(recorded.commit)) return recorded.commit;
  } catch { /* no committed catalog either */ }
  throw new Error(`Catalog needs the source commit: build from a full Git checkout, or from a tree whose ${recordedPath} is for version ${version}.`);
}
