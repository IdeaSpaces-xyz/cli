/**
 * `ideaspaces integrate` — bring what moved elsewhere into this checkout.
 *
 * Which elsewhere is decided by what the checkout is, not by the person: a
 * hosted clone integrates its upstream (`pull`); an unpublished fork integrates
 * its maintained source through the three-way update (`update`). No authority
 * is at stake in that choice, so one verb may make it. A published fork that
 * still carries source lineage has both; its own remote is the default and
 * `--from source` names the other. Plan-first like `get` and `publish`: without
 * `--yes` it reports what it would integrate and mutates nothing.
 */

import { findSpaceFor, isUnpublishedForkRecord } from "../auth/spaces.js";
import { remoteState, repoRoot } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import { pullCommand } from "./pull.js";
import { updateCommand } from "./update.js";

export type IntegrateFrom = "remote" | "source";

const USAGE = "ideaspaces integrate [--yes] [--from remote|source] [--rebase=false] [--json]";

export interface IntegratePlan {
  from: IntegrateFrom;
  /** The other channel this checkout also has, when both apply. */
  also?: IntegrateFrom;
  reason: string;
}

/** Decide the channel from the checkout itself. */
export function planIntegrate(
  record: ReturnType<typeof findSpaceFor>,
  upstream: string | null,
  requested?: IntegrateFrom,
): IntegratePlan | { error: string } {
  const hasSource = Boolean(record?.source_root_node_id);
  const unpublished = record ? isUnpublishedForkRecord(record) : false;
  if (requested === "source") {
    if (!hasSource) return { error: "This checkout has no maintained source; nothing to integrate from source." };
    return { from: "source", reason: "maintained source, three-way (asked)" };
  }
  if (requested === "remote") {
    if (!upstream) return { error: "No upstream configured for the current branch; nothing to integrate from the remote." };
    return { from: "remote", reason: `upstream ${upstream} (asked)` };
  }
  if (unpublished) return { from: "source", reason: "an unpublished fork with a maintained source" };
  if (upstream && hasSource) {
    return { from: "remote", also: "source", reason: `upstream ${upstream}; this fork also has a maintained source` };
  }
  if (upstream) return { from: "remote", reason: `upstream ${upstream}` };
  if (hasSource) return { from: "source", reason: "a maintained source and no upstream" };
  return {
    error:
      "Nothing to integrate from: no upstream on the current branch and no maintained source recorded. `ideaspaces get` binds a clone; `ideaspaces publish` gives a fork a remote.",
  };
}

export const integrateCommand: CommandDef = {
  name: "integrate",
  description: "Bring remote or source changes into this checkout — the channel follows what the checkout is",
  usage: USAGE,
  examples: [
    "ideaspaces integrate              # plan: what would be integrated, from where",
    "ideaspaces integrate --yes        # integrate: pull a clone's upstream, or update a fork from its source",
    "ideaspaces integrate --yes --from source   # a published fork: take source changes instead of the upstream",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const requested = flags.from;
    if (requested !== undefined && requested !== "remote" && requested !== "source") {
      output.error("--from must be `remote` or `source`");
      return 1;
    }
    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    const plan = planIntegrate(findSpaceFor(root), remoteState(root).upstream, requested as IntegrateFrom | undefined);
    if ("error" in plan) {
      output.error(plan.error);
      return 1;
    }
    output.progress(`Integrating from ${plan.from}: ${plan.reason}${plan.also ? ` (\`--from ${plan.also}\` for the other)` : ""}`);
    // Each channel keeps its own command; integrate only chooses. Plan-first:
    // pull's plan is its dry run, update's plan is its default preview.
    if (plan.from === "remote") {
      const pullFlags = global.yes ? flags : { ...flags, "dry-run": true };
      return pullCommand.run([], pullFlags, global);
    }
    return updateCommand.run([], flags, global);
  },
};
