/**
 * `ideaspaces navigate [<path>] [--mark-seen]` — re-derive orientation at a
 * position without changing the working directory.
 *
 * This is the single awareness producer: it composes the fractal contract along
 * the path to `<path>` (foundation from the space root + the deepest
 * guide/purpose/now), then renders the standard awareness block — Now/tree/skills
 * and a since-last-session diff, a Position section, a git-state line, stale-doc
 * drift, and missing-direction drift. With `--workspace <dir>` it also renders the
 * local-agent tier — a working set (home + `--mount`s) and the repo catalog (git
 * repos beside the workspace folder, tagged with sync state + POV) — so a local
 * agent shells this instead of composing it in-process. `--pullable <s:ns,…>`
 * adds the remote/pullable catalog tier the caller already fetched (kept out of
 * navigate so it stays network-free); `--no-git` suppresses the compact git-state
 * line for a caller that renders its own richer state (e.g. pi's `State:` block).
 * `--json` returns `{ text, position, root, repoRoot }` (the catalog rides in
 * `text`); the MCP `is_navigate` tool and the SessionStart hook both shell this so
 * orientation is rendered one way, in one place.
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
import { isInsideWorkTree, headSha } from "../git.js";
import { formatWorkingSetSection, formatCatalogSection } from "../catalog.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const MAX_DRIFT = 10;
const SEEN_REF = "refs/ideaspaces/seen";

// The since-last-session marker lives in a local git ref — no `git.ts` helper
// exists for reading/writing a custom ref, so this thin wrapper is net-new (the
// standard git ops below reuse `git.ts`'s exports).
function gitRef(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// Position section. `base` is the walk/relative root (repo root, or the space
// root outside a repo); `repoRoot` is shown only when there actually is one.
function formatPositionSection(
  pos: string,
  base: string,
  repoRoot: string | null,
  pathContext: Awaited<ReturnType<typeof walkPathContext>>,
): string {
  const spaceRoot = spaceRootLevel(pathContext);
  const branch = currentBranchLevel(pathContext);
  const lines = ["Position:"];
  if (repoRoot) lines.push(`  repo: ${repoRoot}`);
  lines.push(`  cwd: ${relative(base, pos) || "."}`);
  if (spaceRoot) lines.push(`  space root: ${spaceRoot.path || "."}`);
  if (branch) lines.push(`  active _agent: ${branch.path || "."}`);
  return lines.join("\n");
}

// Parse --pullable: a comma-separated list of `slug:namespace` pairs — the
// remote/pullable tier the caller already fetched via `catalog` (kept out of
// navigate so it stays network-free). The flag parser has no arrays, hence the
// string encoding; entries without a colon are dropped, not half-rendered.
function parsePullable(raw: string | boolean | undefined): Array<{ slug: string; namespace: string }> {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      return i > 0 ? { slug: p.slice(0, i), namespace: p.slice(i + 1) } : null;
    })
    .filter((x): x is { slug: string; namespace: string } => x !== null);
}

export const navigateCommand: CommandDef = {
  name: "navigate",
  description: "Re-derive orientation (fractal contract, tree, drift) at a position",
  usage: "ideaspaces navigate [<path>] [--mark-seen] [--workspace <dir>] [--mount <a,b,c>] [--pullable <s:ns,…>] [--no-git]",
  examples: [
    "ideaspaces navigate --json            # orient at the current directory",
    "ideaspaces navigate roadmap --json    # orient at a branch",
    "ideaspaces navigate --workspace . --mount ../other-repo --json  # + local repo catalog + working set",
    "ideaspaces navigate --workspace . --pullable team:acme.com,notes:alice --no-git --json  # + remote tier; caller renders its own state",
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
    if (isInsideWorkTree(target)) {
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

    // Walk/relative base: the repo root, or the space root outside a repo.
    // `walkPathContext` is a pure filesystem walk (no git), so the Position
    // section renders in a non-git ideaspace too.
    const base = repoRoot ?? composed.spaceRoot;
    const lastSha = repoRoot ? gitRef(repoRoot, ["rev-parse", "--verify", "--quiet", SEEN_REF]) ?? undefined : undefined;
    const [block, pathContext] = await Promise.all([
      assembleAwareness({ root: target, contract: composed.contract, lastSha }),
      base ? walkPathContext(base, target) : Promise.resolve(null),
    ]);

    const sections: string[] = [];
    if (pathContext && base) sections.push(formatPositionSection(target, base, repoRoot, pathContext));
    if (block.trim()) sections.push(block);

    // Local-agent orientation tier: the working set (home + mounts) and the repo
    // catalog (git repos that are children of the workspace folder). Rendered
    // only when a --workspace root is given (no cwd default — a caller that omits
    // it never triggers a surprise sibling-repo scan). Ported from pi-is-space so
    // a local agent shells this instead of composing it in-process. The catalog
    // lands in `text`; the --json envelope shape is unchanged (rows stay
    // addressable for a future structured field).
    const workspace = typeof flags.workspace === "string" ? resolve(flags.workspace) : null;
    if (workspace && (!existsSync(workspace) || !statSync(workspace).isDirectory())) {
      // A typo'd --workspace would otherwise render an empty catalog that looks
      // identical to "no repos here" — surface it as a drift line (in `text`,
      // like navigate's other warnings) rather than failing orientation.
      sections.push(`⚠ --workspace is not a readable directory: ${workspace} (catalog skipped)`);
    } else if (workspace) {
      const mounts =
        typeof flags.mount === "string"
          ? flags.mount.split(",").map((m) => m.trim()).filter(Boolean)
          : [];
      const [workingSet, catalog] = await Promise.all([
        formatWorkingSetSection(composed.spaceRoot, mounts),
        formatCatalogSection(workspace, { povRepoRoot: repoRoot, mounts, pullable: parsePullable(flags.pullable) }),
      ]);
      if (workingSet) sections.push(workingSet);
      if (catalog) sections.push(catalog);
    }

    if (repoRoot && gs) {
      const bits: string[] = [];
      if (gs.branch) bits.push(`branch ${gs.branch}`);
      if (gs.ahead != null && gs.behind != null && (gs.ahead || gs.behind)) bits.push(`↑${gs.ahead} ↓${gs.behind}`);
      if (gs.dirty) bits.push("dirty");
      if (gs.untrackedInTrackedDirs.length) bits.push(`${gs.untrackedInTrackedDirs.length} untracked`);
      // --no-git suppresses the compact Git line for callers that render their
      // own richer state (e.g. pi's `State:` block from `cli status`) — avoids a
      // duplicate branch/dirty readout. Stale-docs + mark-seen below are unaffected.
      if (bits.length && !flags["no-git"]) sections.push(`Git: ${bits.join(", ")}`);

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
      // Best-effort: an unborn HEAD or ref-write failure must not fail navigate.
      if (flags["mark-seen"]) {
        try {
          gitRef(repoRoot, ["update-ref", SEEN_REF, headSha(repoRoot)]);
        } catch {
          // no HEAD yet (fresh repo) — nothing to mark
        }
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
