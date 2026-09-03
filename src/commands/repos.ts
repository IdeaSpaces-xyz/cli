import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import { availableRootActions, rootRelationshipLabel } from "../root-actions.js";
import { canonicalSpaceUrl, repoDisplaySlug, repoRouteNamespace } from "../space-locator.js";
import type { CommandDef } from "../types.js";

export const reposCommand: CommandDef = {
  name: "repos",
  description: "List your spaces — relationship and available actions",
  usage: "ideaspaces repos [--json]",
  examples: [
    "ideaspaces repos",
    "ideaspaces repos --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    let me;
    try {
      me = await fetchAuthMe(config);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return 1;
      }
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const repos = me.repos.map((r) => ({
      repo_id: r.repo_id,
      slug: repoDisplaySlug(r),
      hostname: r.hostname ?? null,
      root_node_id: r.root_node_id ?? null,
      route_status: r.route_status ?? null,
      namespace: repoRouteNamespace(r, me.username),
      space_url: r.root_node_id ? canonicalSpaceUrl(config.apiUrl, r.root_node_id) : null,
      relationship: rootRelationshipLabel(r),
      receipt_classes: r.receipt_classes ?? [],
      actions: availableRootActions(r),
    }));

    output.result(
      { username: me.username, repos },
      repos.length
        ? repos
            .map((r) => {
              const actions = r.actions.length ? r.actions.join(", ") : "no available actions";
              return `${r.slug} (${r.relationship}) — ${actions}`;
            })
            .join("\n")
        : "No spaces yet. Create one at your account, or `ideaspaces create`.",
    );
    return 0;
  },
};
