import { getSpaceCopySnapshot, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { findSpaceFor, saveSpace } from "../auth/spaces.js";
import {
  applyForkUpdate,
  describeChanges,
  initialForkBaseline,
  loadForkBaseline,
  normalizeSnapshot,
  planForkUpdate,
  saveForkBaseline,
} from "../fork-update.js";
import { repoRoot } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

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

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    let baseline;
    try {
      baseline = loadForkBaseline(root);
      if (baseline && baseline.source_root_node_id !== record.source_root_node_id) {
        throw new Error("The local fork baseline names a different source; no files were changed.");
      }
      if (!baseline) {
        if (record.source_baseline_initialized) {
          throw new Error("The local fork update baseline is missing; no files were changed.");
        }
        if (!record.source_head) {
          throw new Error("This fork has no pinned source head; no files were changed.");
        }
        baseline = initialForkBaseline(
          root,
          record.source_root_node_id,
          record.source_head,
        );
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    output.progress("Reading the maintained source projection…");
    let snapshot;
    try {
      snapshot = await getSpaceCopySnapshot(config, record.source_root_node_id, {
        timeoutMs: 120_000,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
      } else {
        output.error(
          "The maintained source update channel is unavailable; no local files were changed. " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      return 1;
    }

    let plan;
    try {
      if (
        !snapshot ||
        typeof snapshot.source_head !== "string" ||
        !/^[0-9a-f]{40}$/.test(snapshot.source_head) ||
        !Number.isInteger(snapshot.markdown_file_count) ||
        snapshot.markdown_file_count < 0 ||
        !Number.isInteger(snapshot.markdown_bytes) ||
        snapshot.markdown_bytes < 0 ||
        !Array.isArray(snapshot.files) ||
        snapshot.files.length !== snapshot.markdown_file_count
      ) {
        throw new Error("The source returned an invalid snapshot envelope");
      }
      let receivedBytes = 0;
      for (const file of snapshot.files) {
        if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
          throw new Error("The source returned an invalid snapshot file");
        }
        receivedBytes += Buffer.byteLength(file.content, "utf-8");
      }
      if (receivedBytes > 20_000_000) {
        throw new Error("The source snapshot exceeds the local update limit");
      }
      const incoming = normalizeSnapshot(snapshot.files, baseline.files);
      plan = planForkUpdate(baseline, incoming, root);
    } catch (err) {
      output.error(
        `The source projection could not be validated; no local files were changed. ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const changes = describeChanges(plan);
    if (!global.yes) {
      output.result(
        {
          apply: false,
          source_head: snapshot.source_head,
          writes: Object.keys(plan.writes),
          deletes: plan.deletes,
          conflicts: plan.conflicts,
        },
        changes.length
          ? [
              `Source update ${snapshot.source_head.slice(0, 12)} is ready:`,
              ...changes.map((change) => `  ${change}`),
              "Run `ideaspaces update --yes` to apply non-conflicting changes.",
            ].join("\n")
          : "Already up to date — no source changes to apply.",
      );
      return 0;
    }

    try {
      applyForkUpdate(plan, root);
      // The baseline must become durable before spaces.json advances. If the
      // latter write is interrupted, the baseline remains sufficient to retry
      // safely and heal the display pin on the next successful run.
      saveForkBaseline(root, {
        source_root_node_id: record.source_root_node_id,
        source_head: snapshot.source_head,
        files: plan.incoming,
        conflicts: plan.conflicts,
      });
      saveSpace(root, {
        ...record,
        source_head: snapshot.source_head,
        source_baseline_initialized: true,
      });
    } catch (err) {
      output.error(
        `The update could not be finalized: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    output.result(
      {
        apply: true,
        source_head: snapshot.source_head,
        writes: Object.keys(plan.writes),
        deletes: plan.deletes,
        conflicts: plan.conflicts,
      },
      changes.length
        ? [
            `Updated from source ${snapshot.source_head.slice(0, 12)}.`,
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
