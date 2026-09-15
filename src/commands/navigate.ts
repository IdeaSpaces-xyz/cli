/**
 * `ideaspaces navigate [<path>] [--mark-seen]` — re-derive orientation at a
 * position without changing the working directory. `--focus` instead emits
 * one bounded history reference without changing caller authority.
 *
 * One structured protocol assembly (`assembleContentAwareness`) supplies every
 * fact and its prompt placement. The CLI selects Agreement before Foundation
 * unless `--contract` overrides it, then renders the derived active-context
 * index in three tiers:
 *
 *   1. stable block   — the protocol `head`: position, Now, tree, contract,
 *                       and skills for the active coordinate
 *   2. forest handles — working set (home + `--mount`s) + repository catalog:
 *                       other roots as thin handles; `--pullable <s:ns,…>` adds
 *                       the re-fetchable remote tier the caller already
 *                       fetched, keeping navigate network-free
 *   3. volatile tail  — the protocol `tail`: activity, git state, stale docs,
 *                       and direction drift, rendered last
 *
 * The head is the protocol's placement render; everything after it is the
 * protocol's one Content-tail composition (`renderContentTail`) fed the CLI's
 * forest handles — the same composition `status` renders with State, so the
 * two verbs cannot order the tail differently. A bare folder receives floor
 * orientation plus its catalog; a working set requires a selected authority
 * frame. `--no-git` suppresses the compact git-state line for callers that
 * render richer state. `--json` returns `{ text, position, root, repoRoot,
 * manifest }` — the manifest is the derived projection fragment the text was
 * rendered from, so tooling gets facts without parsing prose.
 *
 * `--mark-seen` persists HEAD as the "last seen" marker for lifecycle callers.
 * Ordinary `navigate` is read-only orientation and does not advance the baseline.
 */

import { relative, resolve } from "node:path";
import { statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  assembleContentAwareness,
  assembleContentFocus,
  renderContentAwareness,
  renderContentFocus,
  renderContentTail,
  resolveRepoRoot,
  CONTENT_AWARENESS_SECTIONS,
} from "@ideaspaces/protocol";
import { contractSourceFlag, preferredContractSource, MAX_DRIFT } from "../contract-source.js";
import { headSha } from "../git.js";
import { floorHint, formatWorkingSetSection, planCatalog } from "../catalog.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const SEEN_REF = "refs/ideaspaces/seen";

// The since-last-session marker lives in a local git ref — no `git.ts` helper
// exists for writing a custom ref, so this thin wrapper is net-new. (Reading it
// is the protocol's job now: `assembleContentAwareness` consumes the seen ref.)
function gitRef(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export const navigateCommand: CommandDef = {
  name: "navigate",
  description: "Orient here, or read another position as bounded reference",
  usage: "ideaspaces navigate [<path>] [--focus] [--contract <foundation|agreement>] [--depth <1..4>] [--mark-seen] [--workspace <dir>] [--mount <a,b,c>] [--pullable <s:ns,…>] [--no-git]",
  examples: [
    "ideaspaces navigate --json            # orient at the current directory",
    "ideaspaces navigate docs --json       # orient at a branch",
    "ideaspaces navigate docs --focus --json  # read a branch as history reference",
    "ideaspaces navigate --contract foundation --json  # explicit compatibility frame",
    "ideaspaces navigate --depth 2 --json  # probe the map: name-rung outline one level below",
    "ideaspaces navigate --workspace . --mount ../other-repo --json  # + local repo catalog + working set",
    "ideaspaces navigate --workspace . --pullable team:acme.com,notes:alice --no-git --json  # + remote tier; caller renders its own state",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const selected = contractSourceFlag(flags.contract);
    if (selected.error) {
      output.error(selected.error);
      return 1;
    }

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

    if (flags.focus) {
      const incompatible = ["depth", "mark-seen", "workspace", "mount", "pullable", "no-git"]
        .filter((name) => flags[name] !== undefined);
      if (incompatible.length) {
        output.error(`--focus cannot be combined with ${incompatible.map((name) => `--${name}`).join(", ")}`);
        return 1;
      }
      const focusOpts = {
        position: target,
        ...(selected.source ? { contractSource: selected.source } : {}),
      };
      let focus = await assembleContentFocus(focusOpts);
      // The protocol remains neutral; the CLI applies its established
      // Agreement → Foundation → floor target-selection policy.
      if (focus?.status === "contract_choice_required" && !selected.source) {
        const preferred = preferredContractSource(focus.availableSources);
        if (preferred) {
          focus = await assembleContentFocus({ ...focusOpts, contractSource: preferred });
        }
      }
      if (!focus) {
        output.error(`Not a Content position: ${target}`);
        return 1;
      }
      if (focus.status !== "ok") {
        output.error(renderContentFocus(focus));
        return 1;
      }
      const text = renderContentFocus(focus);
      const position = relative(focus.position.base, focus.position.path) || ".";
      output.result(
        {
          text,
          position,
          root: focus.spaceRoot,
          repoRoot: focus.position.repoRoot,
          manifest: focus,
        },
        text,
      );
      return 0;
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
    // --depth is deliberate map-probing (the protocol soft-caps to 1..4);
    // ambient callers omit it and stay at the depth-1 orientation default.
    const depth = typeof flags.depth === "string" ? Number.parseInt(flags.depth, 10) : undefined;
    const awarenessOpts = {
      position: target,
      ...(selected.source ? { contractSource: selected.source } : {}),
      ...(depth && Number.isFinite(depth) ? { treeDepth: depth } : {}),
    };
    let awareness = await assembleContentAwareness(awarenessOpts);
    // Protocol selection has no precedence. The CLI is the selecting habitat:
    // explicit flag first, then Agreement, Foundation, and floor.
    if (awareness?.status === "contract_choice_required" && !selected.source) {
      const preferred = preferredContractSource(awareness.availableSources);
      if (preferred) {
        awareness = await assembleContentAwareness({
          ...awarenessOpts,
          contractSource: preferred,
        });
      }
    }

    if (!awareness) {
      output.error(`Not a Content position: ${target}`);
      return 1;
    }
    if (awareness.status !== "ok") {
      output.error(renderContentAwareness(awareness));
      return 1;
    }
    const manifest = awareness;
    const isFloor = manifest.contractSource === null;

    // The catalog is independent IO. A working set requires selected agent
    // terms; floor orientation has a root coordinate but no authority frame.
    const [catalog, workingSet] = await Promise.all([
      cat.kind === "ok" ? cat.catalog : Promise.resolve(null),
      cat.kind === "ok" && !isFloor
        ? formatWorkingSetSection(manifest.spaceRoot, cat.mounts)
        : Promise.resolve(null),
    ]);

    const sections: string[] = [];

    // 1. Stable block — protocol-owned head membership and ordering.
    const stable = renderContentAwareness(manifest, { placement: "head" });
    if (stable.trim()) sections.push(stable);

    // 2. Forest handles — other roots as handles (CLI-owned rendering), then
    //    the protocol-owned tail, both ordered by the one tail composition.
    //    --no-git remains one explicit omission for callers that render richer
    //    state; it does not recreate a local head/tail classification.
    const handles: Array<string | null> = [];
    if (cat.kind === "warn") handles.push(cat.text);
    else if (cat.kind === "ok") {
      handles.push(workingSet, catalog);
      if (isFloor && !repoRoot) handles.push(floorHint(catalog));
    }
    const tail = renderContentTail(manifest, {
      handles,
      ...(flags["no-git"]
        ? { sections: CONTENT_AWARENESS_SECTIONS.filter((section) => section !== "git") }
        : {}),
      maxDrift: MAX_DRIFT,
    });
    if (tail) sections.push(tail);

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
