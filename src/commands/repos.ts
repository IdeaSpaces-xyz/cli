import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const reposCommand: CommandDef = {
  name: "repos",
  description: "List your spaces — slug, role, and member count",
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
      slug: r.slug,
      hostname: r.hostname,
      // Namespace for clone-URL construction: org hostname, else the username.
      namespace: r.hostname ?? me.username,
      role: r.role,
      member_count: r.member_count,
    }));

    output.result(
      { username: me.username, repos },
      repos.length
        ? repos
            .map((r) => `${r.slug}  (${r.role}, ${r.member_count} member${r.member_count === 1 ? "" : "s"})`)
            .join("\n")
        : "No spaces yet. Create one at your account, or `ideaspaces create`.",
    );
    return 0;
  },
};
