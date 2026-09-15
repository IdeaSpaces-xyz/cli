/**
 * `ideaspaces status` — the tail, and only the tail.
 *
 * The default render is the protocol's one Content-tail composition
 * (`renderContentTail`): local State (git position + captures awaiting
 * commit), the CLI's forest handles when `--workspace` is given, then the
 * manifest's tail — activity, stale docs, direction drift. Nothing the head
 * already holds. An agent runtime's post-breakpoint block is the same
 * composition, so the two are byte-identical for the same inputs; the CLI is
 * stateless about Changes, so it never carries a Change line.
 *
 * Two CLI-owned sections sit beside the tail rather than inside it, because
 * they are not Content placement: `status account` (login state) and
 * `status doctor` (installation health). `whoami` and `doctor` remain their
 * legacy names for one release.
 *
 * `--path FILE` is the single-file revision query (the `if_match` source);
 * `--json` returns the git/capture fields plus `root_identity`, `text` (the
 * shared tail), and `hints` (CLI-owned next steps, appended after the tail
 * in human output).
 */

import {
  assembleContentAwareness,
  assembleContentState,
  pathRevision,
  renderContentAwareness,
  renderContentTail,
} from "@ideaspaces/protocol";
import { planCatalog } from "../catalog.js";
import { contractSourceFlag, preferredContractSource, MAX_DRIFT } from "../contract-source.js";
import { fetch as gitFetch } from "../git.js";
import {
  canonicalRepoRoot,
  localEffectCapabilities,
  toPortableRepoPath,
} from "../local-effects-adapter.js";
import { createOutput } from "../output.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import type { CommandDef } from "../types.js";
import { doctorCommand } from "./doctor.js";
import { whoamiCommand } from "./whoami.js";

export const STATUS_SECTIONS: Record<string, CommandDef> = {
  account: whoamiCommand,
  doctor: doctorCommand,
};

export const statusCommand: CommandDef = {
  name: "status",
  description: "Show the volatile tail: git state, captures awaiting commit, activity, drift",
  usage:
    "ideaspaces status [account|doctor] [--path FILE] [--fetch] [--workspace <dir>] [--mount <a,b>] [--pullable <s:ns,…>] [--contract <foundation|agreement>] [--json]",
  examples: [
    "ideaspaces status",
    "ideaspaces status --json",
    "ideaspaces status --fetch  # fetch first, so ahead/behind reflect the remote",
    "ideaspaces status --workspace .. --mount ../other  # + repo catalog, as an agent runtime sees it",
    "ideaspaces status --path notes/a.md  # single-file state + sha (if_match source)",
    "ideaspaces status account  # login state (legacy name: whoami)",
    "ideaspaces status doctor   # installation health (legacy name: doctor)",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    // CLI-owned sections: account identity and installation health are not
    // Content placement, so they render on their own, never inside the tail.
    const section = args[0];
    if (section !== undefined) {
      const command = Object.hasOwn(STATUS_SECTIONS, section) ? STATUS_SECTIONS[section] : undefined;
      if (!command) {
        output.error(`Unknown status section: ${section} (expected account or doctor)`);
        return 1;
      }
      return command.run(args.slice(1), flags, global);
    }

    let root: string;
    try {
      root = canonicalRepoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Single-path mode: the sha here is what the caller passes as if_match to
    // safely update a file it didn't just write.
    const pathArg = typeof flags.path === "string" ? flags.path : undefined;
    if (pathArg) {
      const portablePath = toPortableRepoPath(pathArg, root);
      if (!portablePath) {
        output.error(`Path is outside the repository root: ${pathArg}`);
        return 1;
      }
      const read = await pathRevision(
        root,
        portablePath,
        localEffectCapabilities.git,
        localEffectCapabilities.filesystem,
      );
      if (read.status === "error") {
        if (global.json) output.result(read, "");
        else output.error(`${read.message}${read.path ? ` (${read.path})` : ""}`);
        return 1;
      }
      const revision = read.revision;
      const exists = revision.worktree !== null;
      const inIndex = revision.index !== revision.head;
      const modified = revision.worktree !== revision.index;
      const inTracked = revision.index !== null;
      output.result(
        {
          path: pathArg,
          exists,
          sha: revision.worktree,
          in_index: inIndex,
          modified,
          in_tracked: inTracked,
          revision,
        },
        exists
          ? `${pathArg}: sha ${revision.worktree}${inIndex ? ", staged" : ""}${modified ? ", modified" : ""}${inTracked ? "" : ", untracked"}`
          : `${pathArg}: does not exist`,
      );
      return 0;
    }

    const selected = contractSourceFlag(flags.contract);
    if (selected.error) {
      output.error(selected.error);
      return 1;
    }

    // Read-only: fetch then report, never integrate (that's `pull`).
    if (flags.fetch) {
      try {
        gitFetch(root);
      } catch (err) {
        output.error(`git fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    const position = process.cwd();
    const cat = planCatalog(flags, root);
    const awarenessOpts = {
      position,
      ...(selected.source ? { contractSource: selected.source } : {}),
    };
    // State, the manifest, and the catalog are independent IO.
    const [state, firstRead, catalog] = await Promise.all([
      assembleContentState(root),
      assembleContentAwareness(awarenessOpts),
      cat.kind === "ok" ? cat.catalog : Promise.resolve(null),
    ]);
    let awareness = firstRead;
    // Protocol selection has no precedence; the CLI applies its habitat policy.
    if (awareness?.status === "contract_choice_required" && !selected.source) {
      const preferred = preferredContractSource(awareness.availableSources);
      if (preferred) {
        awareness = await assembleContentAwareness({ ...awarenessOpts, contractSource: preferred });
      }
    }
    if (awareness && awareness.status !== "ok") {
      output.error(renderContentAwareness(awareness));
      return 1;
    }
    // A null manifest is a position that is not Content (inside an extension
    // payload, say). Unlike navigate, status does not refuse: the repository
    // State is real there, and the composer accepts a null manifest.

    let rootIdentity;
    try {
      rootIdentity = inspectLocalRootIdentity(root);
    } catch (err) {
      output.error(`Could not inspect Space identity: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // Forest handles as the runtimes render them. The bare-workspace floor
    // hint never applies: status requires a repository, and the hint is for
    // positions outside one.
    const handles = cat.kind === "warn" ? [cat.text] : cat.kind === "ok" ? [catalog] : [];
    const text = renderContentTail(awareness, { state, handles, maxDrift: MAX_DRIFT });

    // CLI-owned next-step hints, after the tail and only when there is a step
    // to take. They name CLI verbs, so they are not the protocol's to render;
    // `text` stays the shared tail so a runtime can compare bytes against it.
    const hints: string[] = [];
    if (rootIdentity.declaration.dirty) {
      hints.push("identity declaration: uncommitted change (publish will refuse)");
    }
    if (state.captures.length) {
      hints.push('Save captures: ideaspaces commit -m "<message>" --all');
    }

    output.result(
      {
        repoRoot: state.git.repoRoot,
        branch: state.git.branch,
        ahead: state.git.ahead,
        behind: state.git.behind,
        dirty: state.git.dirty,
        untracked_in_tracked_dirs: state.git.untrackedInTrackedDirs,
        tracked_captures: state.captures,
        root_identity: rootIdentity,
        text,
        hints,
      },
      [text, ...hints].join("\n\n"),
    );
    return 0;
  },
};
