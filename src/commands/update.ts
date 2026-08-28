import { getSpaceCopySnapshot, optionalAuthRead } from "../auth/api.js";
import { loadOptionalAuthConfig } from "../auth/credentials.js";
import { findSpaceFor, saveSpace } from "../auth/spaces.js";
import {
  applyForkUpdate,
  describeChanges,
  initialForkBaseline,
  loadForkBaseline,
  planForkUpdate,
  saveForkBaseline,
  withForkAssetBaseline,
  type ForkSourceBaseline,
  type ForkUpdateConflict,
} from "../fork-update.js";
import { prepareForkSnapshot } from "../fork-snapshot.js";
import { repoRoot } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function conflictsEqual(left: ForkUpdateConflict[], right: ForkUpdateConflict[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) => item.path === right[index]?.path && item.kind === right[index]?.kind,
    )
  );
}

function sourceUpdateError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/→ (?:401|403|404):/.test(detail)) {
    return "The maintained source is unavailable. It may no longer be shared or allow Fork; no local state was changed.";
  }
  return `The maintained source update channel is unavailable; no local state was changed. ${detail}`;
}

function writePaths(plan: ReturnType<typeof planForkUpdate>): string[] {
  return [...Object.keys(plan.writes), ...Object.keys(plan.asset_writes)].sort();
}

export const updateCommand: CommandDef = {
  name: "update",
  description: "Apply maintained source updates to a fork without displacing local work",
  usage: "ideaspaces update [--yes]",
  examples: [
    "ideaspaces update       # preview source changes and conflicts",
    "ideaspaces update --yes # apply non-conflicting source changes",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const record = findSpaceFor(root);
    if (!record?.source_root_node_id) {
      output.error("This Space is not recorded as a fork with a maintained source.");
      return 1;
    }

    let baseline: ForkSourceBaseline;
    let baselineCreated = false;
    let baselineMigrated = false;
    try {
      const loaded = loadForkBaseline(root);
      if (loaded && loaded.source_root_node_id !== record.source_root_node_id) {
        throw new Error("The local fork baseline names a different source; no files were changed.");
      }
      if (!loaded) {
        if (record.source_baseline_initialized) {
          throw new Error("The local fork update baseline is missing; no files were changed.");
        }
        if (!record.source_head) {
          throw new Error("This fork has no pinned source head; no files were changed.");
        }
        baseline = initialForkBaseline(root, record.source_root_node_id, record.source_head);
        baselineCreated = true;
      } else {
        const hydrated = withForkAssetBaseline(root, loaded);
        baseline = hydrated.baseline;
        baselineMigrated = hydrated.migrated;
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    output.progress("Reading the maintained source projection…");
    let snapshot: Awaited<ReturnType<typeof getSpaceCopySnapshot>>;
    try {
      const read = await optionalAuthRead(loadOptionalAuthConfig(), (config) =>
        getSpaceCopySnapshot(config, record.source_root_node_id!, { timeoutMs: 120_000 }),
      );
      snapshot = read.value;
    } catch (err) {
      output.error(sourceUpdateError(err));
      return 1;
    }

    let prepared: ReturnType<typeof prepareForkSnapshot>;
    let plan: ReturnType<typeof planForkUpdate>;
    try {
      prepared = prepareForkSnapshot(snapshot, baseline.files);
      plan = planForkUpdate(baseline, prepared.markdown, root, prepared.assets);
      if (
        baseline.source_head === prepared.sourceHead &&
        (!recordsEqual(baseline.files, plan.incoming) ||
          (!baselineMigrated && !recordsEqual(baseline.assets ?? {}, plan.incoming_assets)))
      ) {
        throw new Error("The source projection changed without changing its source head");
      }
    } catch (err) {
      output.error(
        `The source projection could not be validated; no local state was changed. ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const writes = writePaths(plan);
    const changes = describeChanges(plan);
    const worktreeNeeded = writes.length > 0 || plan.deletes.length > 0;
    const baselineNeeded =
      baselineCreated ||
      baselineMigrated ||
      baseline.source_head !== prepared.sourceHead ||
      !recordsEqual(baseline.files, plan.incoming) ||
      !recordsEqual(baseline.assets ?? {}, plan.incoming_assets) ||
      !conflictsEqual(baseline.conflicts, plan.conflicts);
    const registryNeeded =
      record.source_head !== prepared.sourceHead || !record.source_baseline_initialized;
    const changed = worktreeNeeded || baselineNeeded || registryNeeded;

    const result = {
      apply: global.yes,
      changed,
      worktree_changed: worktreeNeeded,
      source_head: prepared.sourceHead,
      writes,
      asset_writes: Object.keys(plan.asset_writes).sort(),
      deletes: plan.deletes,
      conflicts: plan.conflicts,
    };

    if (!global.yes) {
      output.result(
        result,
        !changed
          ? plan.conflicts.length
            ? `Already up to date — ${plan.conflicts.length} unresolved conflict(s) remain.`
            : "Already up to date — no source changes to apply."
          : changes.length
            ? [
                `Source update ${prepared.sourceHead.slice(0, 12)} is ready:`,
                ...changes.map((change) => `  ${change}`),
                "Run `ideaspaces update --yes` to apply non-conflicting changes.",
              ].join("\n")
            : "Source content is current; run `ideaspaces update --yes` to finish local baseline recovery.",
      );
      return 0;
    }

    if (worktreeNeeded) {
      try {
        applyForkUpdate(plan, root);
      } catch (err) {
        output.error(
          `The source update could not be applied; baseline and registry were not advanced. ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    if (baselineNeeded) {
      try {
        saveForkBaseline(root, {
          source_root_node_id: record.source_root_node_id,
          source_head: prepared.sourceHead,
          files: plan.incoming,
          assets: plan.incoming_assets,
          conflicts: plan.conflicts,
        });
      } catch (err) {
        output.error(
          `${worktreeNeeded ? "Source changes reached the worktree, but" : "The worktree was unchanged and"} the durable baseline could not be advanced. Rerun the identical update to recover safely. ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    if (registryNeeded) {
      try {
        saveSpace(root, {
          ...record,
          source_head: prepared.sourceHead,
          source_baseline_initialized: true,
        });
      } catch (err) {
        output.error(
          `The source baseline is current, but the local registry pin could not be advanced. Rerun the identical update to repair it. ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    output.result(
      result,
      !changed
        ? plan.conflicts.length
          ? `Already up to date — ${plan.conflicts.length} unresolved conflict(s) remain.`
          : "Already up to date — no source changes to apply."
        : changes.length
          ? [
              `Updated from source ${prepared.sourceHead.slice(0, 12)}.`,
              ...changes.map((change) => `  ${change}`),
              ...(plan.conflicts.length
                ? ["Conflicting local files were preserved; resolve them before the next update."]
                : []),
            ].join("\n")
          : "Already up to date — the source baseline is current.",
    );
    return 0;
  },
};
