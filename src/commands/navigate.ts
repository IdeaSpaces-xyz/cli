/**
 * `ideaspaces navigate [<path>] [--mark-seen]` — re-derive orientation at a
 * position without changing the working directory.
 *
 * One structured protocol assembly (`assembleContentAwareness`) supplies every
 * fact; the CLI owns placement. The output follows the disclosure ladder:
 *
 *   1. stable block  — position, Now, tree, contract, skills, activity
 *                      (the vantage and the focal point's loaded depth)
 *   2. map tier      — working set (home + `--mount`s) + repository catalog:
 *                      other roots as thin handles; `--pullable <s:ns,…>` adds
 *                      the released/re-fetchable remote tier the caller already
 *                      fetched, keeping navigate network-free
 *   3. drift tail    — git state, stale docs, direction drift: the volatile
 *                      check-before-acting layer, rendered last
 *
 * Two selective renders around the CLI's map tier are the protocol's placement
 * seam working as designed — wording stays protocol-owned, placement stays
 * harness-owned. The catalog renders even with **no `_agent/` contract** (a
 * bare workspace folder's repos are its orientation); the working set needs a
 * space root. `--no-git` suppresses the compact git-state line for callers
 * that render richer state. `--json` returns `{ text, position, root,
 * repoRoot, manifest }` — the manifest is the structured awareness the text
 * was rendered from, so tooling gets facts without parsing prose.
 *
 * `--mark-seen` persists HEAD as the "last seen" marker for lifecycle callers.
 * Ordinary `navigate` is read-only orientation and does not advance the baseline.
 */

import { relative, resolve } from "node:path";
import { statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  assembleContentAwareness,
  renderContentAwareness,
  resolveRepoRoot,
  type ContentAwarenessSection,
} from "@ideaspaces/protocol";
import { headSha } from "../git.js";
import { formatWorkingSetSection, formatCatalogSection } from "../catalog.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const MAX_DRIFT = 10;
const SEEN_REF = "refs/ideaspaces/seen";

// The stable block ends at activity; the drift tail starts at git. The CLI's
// map tier renders between them (see the header comment).
const STABLE_SECTIONS: readonly ContentAwarenessSection[] = [
  "position",
  "now",
  "tree",
  "contract",
  "skills",
  "activity",
];

// The since-last-session marker lives in a local git ref — no `git.ts` helper
// exists for writing a custom ref, so this thin wrapper is net-new. (Reading it
// is the protocol's job now: `assembleContentAwareness` consumes the seen ref.)
function gitRef(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
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

// Shown at a bare workspace folder (no `_agent/` contract, not a git repo) where
// the catalog IS the orientation — a nudge to move into one of the listed repos.
// Two copies so the empty first-touch folder doesn't say "navigate into a repo
// below" with nothing below.
const BARE_FOLDER_HINT =
  "You're at a workspace folder (no `_agent/` contract here). Navigate into a repo below (`ideaspaces navigate <repo>`), or pull one that's behind.";
const EMPTY_FOLDER_HINT =
  "You're at a workspace folder with no repos yet. Clone one to get started (`ideaspaces clone`).";

type CatalogPlan =
  | { kind: "none" }
  | { kind: "warn"; text: string }
  | { kind: "ok"; mounts: string[]; catalog: Promise<string | null> };

// Resolve --workspace and **start** rendering the local-agent repo catalog
// (local + pullable tiers). Synchronous — it returns the in-flight promise so the
// caller can await it alongside the awareness assembly (independent IO, run
// concurrently). Independent of the `_agent/` contract, so the catalog renders
// at a bare folder too. Warning for an unreadable --workspace; none when the
// flag is absent.
function planCatalog(flags: Record<string, string | boolean>, povRepoRoot: string | null): CatalogPlan {
  const workspace = typeof flags.workspace === "string" ? resolve(flags.workspace) : null;
  if (!workspace) return { kind: "none" };
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    // A typo'd --workspace would otherwise look identical to "no repos here" —
    // surface it as a drift line rather than silently rendering nothing.
    return { kind: "warn", text: `⚠ --workspace is not a readable directory: ${workspace} (catalog skipped)` };
  }
  const mounts =
    typeof flags.mount === "string" ? flags.mount.split(",").map((m) => m.trim()).filter(Boolean) : [];
  const catalog = formatCatalogSection(workspace, { povRepoRoot, mounts, pullable: parsePullable(flags.pullable) });
  return { kind: "ok", mounts, catalog };
}

export const navigateCommand: CommandDef = {
  name: "navigate",
  description: "Re-derive orientation (fractal contract, tree, drift) at a position",
  usage: "ideaspaces navigate [<path>] [--mark-seen] [--workspace <dir>] [--mount <a,b,c>] [--pullable <s:ns,…>] [--no-git]",
  examples: [
    "ideaspaces navigate --json            # orient at the current directory",
    "ideaspaces navigate docs --json       # orient at a branch",
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

    // Canonical git root, or null outside a repo — the bare path needs it for
    // the hint choice and the catalog's POV tag. On the contract path the
    // manifest re-derives it with the same canonicalization.
    const repoRoot = await resolveRepoRoot(target);

    // The repo catalog is independent of the `_agent/` contract, so start it up
    // front — at a bare workspace folder (no contract) the catalog IS the
    // orientation. `planCatalog` is sync; the promise resolves where awaited.
    const cat = planCatalog(flags, repoRoot);

    // One structured assembly replaces the previous six protocol calls: the
    // position walk, contract composition, awareness block, git state,
    // stale-doc signals, and the seen-ref read all happen inside, concurrently.
    const manifest = await assembleContentAwareness({ position: target });

    if (!manifest) {
      // No contract here (a bare workspace folder, or a plain repo). With a
      // --workspace the catalog is the orientation — which repos are here — plus
      // a nudge (into a repo if any are listed, else to clone) at a bare folder.
      const position = relative(repoRoot ?? target, target) || ".";
      const bare: string[] = [];
      if (cat.kind === "warn") bare.push(cat.text);
      else if (cat.kind === "ok") {
        const catalog = await cat.catalog;
        if (catalog) bare.push(catalog);
        if (!repoRoot) bare.push(catalog ? BARE_FOLDER_HINT : EMPTY_FOLDER_HINT);
      }
      output.result(
        { text: bare.length ? bare.join("\n\n") : null, position, root: null, repoRoot, manifest: null },
        bare.length ? bare.join("\n\n") : "No _agent/ contract resolves at this position.",
      );
      return 0;
    }

    // The catalog and working set are independent IO started above; the working
    // set needs the space root, so it renders only on this (contract) path.
    const [catalog, workingSet] = await Promise.all([
      cat.kind === "ok" ? cat.catalog : Promise.resolve(null),
      cat.kind === "ok" ? formatWorkingSetSection(manifest.spaceRoot, cat.mounts) : Promise.resolve(null),
    ]);

    const sections: string[] = [];

    // 1. Stable block — the vantage and the focal point's loaded depth.
    const stable = renderContentAwareness(manifest, { sections: STABLE_SECTIONS });
    if (stable.trim()) sections.push(stable);

    // 2. Map tier — other roots as handles (CLI-owned rendering and placement).
    if (cat.kind === "warn") sections.push(cat.text);
    else if (cat.kind === "ok") {
      if (workingSet) sections.push(workingSet);
      if (catalog) sections.push(catalog);
    }

    // 3. Drift tail — volatile state last, closest to action. --no-git
    // suppresses the compact Git line for callers that render their own richer
    // state (e.g. pi's `State:` block from `cli status`).
    const tailSections: ContentAwarenessSection[] = [
      ...(flags["no-git"] ? [] : (["git"] as const)),
      "stale-docs",
      "direction-drift",
    ];
    const tail = renderContentAwareness(manifest, { sections: tailSections, maxDrift: MAX_DRIFT });
    if (tail.trim()) sections.push(tail);

    // Persist the since-last-session baseline only when asked (SessionStart).
    // Best-effort: an unborn HEAD or ref-write failure must not fail navigate.
    const canonicalRepoRoot = manifest.position.repoRoot;
    if (canonicalRepoRoot && flags["mark-seen"]) {
      try {
        gitRef(canonicalRepoRoot, ["update-ref", SEEN_REF, headSha(canonicalRepoRoot)]);
      } catch {
        // no HEAD yet (fresh repo) — nothing to mark
      }
    }

    const position = relative(manifest.position.base, manifest.position.path) || ".";
    const text = sections.join("\n\n");
    output.result(
      { text: text || null, position, root: manifest.spaceRoot, repoRoot: canonicalRepoRoot, manifest },
      text || "(no orientation)",
    );
    return 0;
  },
};
