import { resolve } from "node:path";
import { deriveGitBase, fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { saveSpace } from "../auth/spaces.js";
import { cloneRepo } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const cloneCommand: CommandDef = {
  name: "clone",
  description: "Clone one of your spaces into a local folder",
  usage: "ideaspaces clone <space> [dir]",
  examples: [
    "ideaspaces clone notes                 # clone into ./notes",
    "ideaspaces clone ernests_s/notes ./n   # explicit namespace/slug + dir",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);

    const target = args[0];
    if (!target) {
      output.error("Usage: ideaspaces clone <space> [dir]");
      return 1;
    }

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

    // Resolve the space by repo_id, slug, or namespace/slug.
    const matches = me.repos.filter((r) => {
      const namespace = r.hostname ?? me.username;
      return r.repo_id === target || r.slug === target || `${namespace}/${r.slug}` === target;
    });
    if (matches.length === 0) {
      output.error(`No space matches "${target}". Run \`ideaspaces repos\` to list yours.`);
      return 1;
    }
    if (matches.length > 1) {
      output.error(`"${target}" is ambiguous — use namespace/slug or the repo_id.`);
      return 1;
    }

    const repo = matches[0];
    const namespace = repo.hostname ?? me.username;
    if (!namespace) {
      output.error("Could not resolve the space namespace.");
      return 1;
    }

    const url = `${deriveGitBase(config.apiUrl)}/${namespace}/${repo.slug}.git`;
    const dir = resolve(args[1] ?? repo.slug);

    try {
      cloneRepo(url, dir);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Bind the folder to the space so `sync` knows what it is.
    saveSpace(dir, { repo_id: repo.repo_id, slug: repo.slug, namespace });

    output.result(
      { repo_id: repo.repo_id, slug: repo.slug, namespace, path: dir },
      `Cloned ${namespace}/${repo.slug} → ${dir}`,
    );
    return 0;
  },
};
