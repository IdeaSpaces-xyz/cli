import { isUnpublishedForkRecord, loadSpaces } from "../auth/spaces.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const clonesCommand: CommandDef = {
  name: "clones",
  description: "List local checkouts — hosted clones and unpublished local forks",
  usage: "ideaspaces clones [--json]",
  examples: [
    "ideaspaces clones",
    "ideaspaces clones --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);

    const clones = Object.entries(loadSpaces()).map(([path, record]) =>
      isUnpublishedForkRecord(record)
        ? {
            path,
            state: "unpublished_fork" as const,
            repo_id: null,
            root_node_id: record.root_node_id,
            name: record.name,
            source_root_node_id: record.source_root_node_id,
            source_head: record.source_head,
          }
        : {
            path,
            state: "hosted" as const,
            repo_id: record.repo_id,
            root_node_id: record.root_node_id ?? null,
            slug: record.slug,
            namespace: record.namespace,
          },
    );

    output.result(
      { clones },
      clones.length
        ? clones
            .map((clone) =>
              clone.state === "unpublished_fork"
                ? `${clone.name}  unpublished local fork  ${clone.path}`
                : `${clone.namespace}/${clone.slug}  ${clone.path}`,
            )
            .join("\n")
        : "No local clones or forks yet. `ideaspaces clone <space>` to make one.",
    );
    return 0;
  },
};
