/**
 * `ideaspaces navigate [<path>] [--mark-seen]` — re-derive orientation at a
 * position without changing the working directory.
 *
 * This is the single awareness producer: it composes the fractal contract along
 * the path to `<path>` (foundation from the space root + the deepest
 * guide/purpose/now), then renders the standard awareness block — Now/tree/skills
 * and a since-last-session diff, a Position section, a git-state line, stale-doc
 * drift, and missing-direction drift. `--json` returns `{ text, position, root,
 * repoRoot }`; the MCP `is_navigate` tool and the SessionStart hook both shell
 * this so orientation is rendered one way, in one place.
 *
 * `--mark-seen` persists HEAD as the "last seen" marker (a local git ref) so the
 * *next* session's since-last-session diff has a baseline. Only the SessionStart
 * hook passes it — a mid-session `navigate` is read-only orientation and must not
 * advance the baseline.
 */

import { relative, resolve } from "node:path";
import { statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  composeContractAlongPath,
  assembleAwareness,
  gitState,
  walkPathContext,
  spaceRootLevel,
  currentBranchLevel,
  collectDocDependencies,
  staleDocSignals,
} from "@ideaspaces/sdk";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const MAX_DRIFT = 10;
const SEEN_REF = "refs/ideaspaces/seen";

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function formatPositionSection(
  pos: string,
  repoRoot: string,
  pathContext: Awaited<ReturnType<typeof walkPathContext>>,
): string {
  const spaceRoot = spaceRootLevel(pathContext);
  const branch = currentBranchLevel(pathContext);
  const lines = ["Position:", `  repo: ${repoRoot}`, `  cwd: ${relative(repoRoot, pos) || "."}`];
  if (spaceRoot) lines.push(`  space root: ${spaceRoot.path || "."}`);
  if (branch) lines.push(`  active _agent: ${branch.path || "."}`);
  return lines.join("\n");
}

export const navigateCommand: CommandDef = {
  name: "navigate",
  description: "Re-derive orientation (fractal contract, tree, drift) at a position",
  usage: "ideaspaces navigate [<path>] [--mark-seen]",
  examples: [
    "ideaspaces navigate --json            # orient at the current directory",
    "ideaspaces navigate roadmap --json    # orient at a branch",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const raw = (args[0] ?? ".").trim();
    const target = resolve(raw === "" ? "." : raw);
    // Distinguish "doesn't exist" from "exists but isn't a directory" for a
    // useful hint. Flags follow the path (`navigate <path> --mark-seen`); the
    // shared parser would otherwise read a path *after* `--mark-seen` as its value.
    if (!existsSync(target)) {
      output.error(`No such path: ${target}`);
      return 1;
    }
    if (!statSync(target).isDirectory()) {
      output.error(`Not a directory: ${target}`);
      return 1;
    }

    // Git root (best-effort; navigate works outside a repo too). `gitState`
    // returns the queried dir — not null — when there's no repo, so check
    // explicitly first; otherwise "outside a repo" is indistinguishable and the
    // position/git-state/stale-docs paths would misbehave.
    let repoRoot: string | null = null;
    let gs: Awaited<ReturnType<typeof gitState>> | undefined;
    if (git(target, ["rev-parse", "--is-inside-work-tree"]) === "true") {
      gs = await gitState(target);
      repoRoot = gs.repoRoot;
    }

    // The fractal contract along the path. No space root → no orientation.
    const composed = await composeContractAlongPath(target);
    // Position is relative to the repo root, or the space root when there's no
    // repo (navigate works outside git too), or the target itself as a last
    // resort. Basing it on `target` alone would always collapse to ".".
    const position = relative(repoRoot ?? composed.spaceRoot ?? target, target) || ".";
    if (!composed.spaceRoot) {
      output.result(
        { text: null, position, root: null, repoRoot },
        "No _agent/ contract resolves at this position.",
      );
      return 0;
    }

    const lastSha = repoRoot ? git(repoRoot, ["rev-parse", "--verify", "--quiet", SEEN_REF]) ?? undefined : undefined;
    const [block, pathContext] = await Promise.all([
      assembleAwareness({ root: target, contract: composed.contract, lastSha }),
      repoRoot ? walkPathContext(repoRoot, target) : Promise.resolve(null),
    ]);

    const sections: string[] = [];
    if (pathContext && repoRoot) sections.push(formatPositionSection(target, repoRoot, pathContext));
    if (block.trim()) sections.push(block);

    if (repoRoot && gs) {
      const bits: string[] = [];
      if (gs.branch) bits.push(`branch ${gs.branch}`);
      if (gs.ahead != null && gs.behind != null && (gs.ahead || gs.behind)) bits.push(`↑${gs.ahead} ↓${gs.behind}`);
      if (gs.dirty) bits.push("dirty");
      if (gs.untrackedInTrackedDirs.length) bits.push(`${gs.untrackedInTrackedDirs.length} untracked`);
      if (bits.length) sections.push(`Git: ${bits.join(", ")}`);

      const signals = await staleDocSignals(repoRoot, await collectDocDependencies(repoRoot, repoRoot));
      if (signals.length) {
        const lines = ["⚠ Possible stale docs — verify before quoting their status:"];
        for (const s of signals.slice(0, MAX_DRIFT)) {
          lines.push(
            s.kind === "stale"
              ? `  ${s.doc} — \`${s.newestCode}\` was committed after the doc`
              : `  ${s.doc} — references missing path(s): ${s.missing.join(", ")}`,
          );
        }
        if (signals.length > MAX_DRIFT) lines.push(`  … and ${signals.length - MAX_DRIFT} more`);
        sections.push(lines.join("\n"));
      }

      // Persist the since-last-session baseline only when asked (SessionStart).
      if (flags["mark-seen"]) {
        const head = git(repoRoot, ["rev-parse", "HEAD"]);
        if (head) git(repoRoot, ["update-ref", SEEN_REF, head]);
      }
    }

    const direction: string[] = [];
    if (!composed.contract.purpose) {
      direction.push(
        "⚠ `_agent/purpose.md` not yet captured. The contract names it; suggest capturing at a natural moment.",
      );
    }
    if (!composed.contract.now) {
      direction.push("⚠ `_agent/now.md` not yet captured. Suggest capturing what's currently active.");
    }
    if (direction.length) sections.push(direction.join("\n"));

    const text = sections.join("\n\n");
    output.result(
      { text: text || null, position, root: composed.spaceRoot, repoRoot },
      text || "(no orientation)",
    );
    return 0;
  },
};
