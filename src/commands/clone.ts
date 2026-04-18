/**
 * `ideaspaces clone <namespace>/<slug>` — clone a space to local disk via git.
 *
 * Supports:
 *   - Explicit:  ideaspaces clone <namespace>/<slug> [dir]
 *   - Bare slug: ideaspaces clone <slug> [dir]   (resolves by calling listRepos)
 *
 * Namespace is a user handle (alphanumeric, no dot) or a hostname (contains a dot).
 * For bare-slug form, we default to the caller's personal repo when one matches,
 * and hint if a hostname variant with the same slug also exists.
 *
 * Auth: requires `ideaspaces login` first. Credential helper is registered on
 * login so the spawned `git clone` transparently uses the stored API key.
 */

import { spawn } from "node:child_process";
import { createClient } from "@ideaspaces/sdk";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

interface RepoSummary {
  repo_id: string;
  slug: string;
  hostname: string | null;
  name?: string | null;
  role?: string | null;
}

export const cloneCommand: CommandDef = {
  name: "clone",
  description: "Clone an IdeaSpaces space to your local machine via git",
  usage: "ideaspaces clone <namespace>/<slug> [directory]",
  examples: [
    "ideaspaces clone my-notes",
    "ideaspaces clone stripe.com/architecture",
    "ideaspaces clone stripe.com/notes ./work/notes",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);
    const target = args[0];
    const directory = args[1];

    if (!target) {
      output.error("Usage: ideaspaces clone <namespace>/<slug> [directory]");
      return 2;
    }

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 1;
    }

    let namespace: string;
    let slug: string;

    if (target.includes("/")) {
      const parts = target.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        output.error("Invalid target. Use <namespace>/<slug>.");
        return 2;
      }
      namespace = parts[0];
      slug = parts[1];
    } else {
      // Bare slug — resolve via listRepos + /auth/me
      slug = target;
      const resolved = await resolveBareSlug(config, slug, output);
      if (!resolved) return 4;
      namespace = resolved.namespace;
      if (resolved.hint) output.progress(resolved.hint);
    }

    const gitUrl = gitUrlFor(namespace, slug);
    const gitArgs = ["clone", gitUrl];
    if (directory) gitArgs.push(directory);

    output.progress(`$ git ${gitArgs.join(" ")}`);

    return await spawnGit(gitArgs);
  },
};

// ─── URL construction ──────────────────────────────────────────────────

function gitUrlFor(namespace: string, slug: string): string {
  const base = (process.env.IS_GIT_URL || "https://git.ideaspaces.xyz").replace(
    /\/+$/,
    "",
  );
  return `${base}/${namespace}/${slug}.git`;
}

// ─── Bare-slug resolution ──────────────────────────────────────────────

interface ResolvedBareSlug {
  namespace: string;
  hint?: string;
}

async function resolveBareSlug(
  config: { apiKey: string; apiUrl: string },
  slug: string,
  output: ReturnType<typeof createOutput>,
): Promise<ResolvedBareSlug | null> {
  const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });
  const { data } = await client.listRepos();
  const repos = data.repos as RepoSummary[];
  const matches = repos.filter((r) => r.slug === slug);

  if (matches.length === 0) {
    output.error(`No space found with slug "${slug}".`);
    return null;
  }

  const personal = matches.find((r) => !r.hostname);
  const hostnameMatches = matches.filter((r) => r.hostname);

  if (personal) {
    const username = await fetchUsername(config);
    if (!username) {
      output.error(
        `Could not resolve your username. Try the explicit form: ideaspaces clone <namespace>/${slug}`,
      );
      return null;
    }
    let hint: string | undefined;
    if (hostnameMatches.length > 0) {
      const others = hostnameMatches.map((r) => `${r.hostname}/${slug}`).join(", ");
      hint = `Cloning personal "${slug}". Hostname variants also exist: ${others}`;
    }
    return { namespace: username, hint };
  }

  if (hostnameMatches.length === 1) {
    return { namespace: hostnameMatches[0].hostname as string };
  }

  // Multiple hostname matches, no personal — ambiguous
  const options = hostnameMatches.map((r) => `${r.hostname}/${slug}`).join(", ");
  output.error(
    `Multiple spaces match "${slug}": ${options}. Specify explicitly: ideaspaces clone <namespace>/<slug>`,
  );
  return null;
}

async function fetchUsername(config: {
  apiKey: string;
  apiUrl: string;
}): Promise<string | null> {
  try {
    const resp = await fetch(`${config.apiUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { username?: string | null };
    return data.username ?? null;
  } catch {
    return null;
  }
}

// ─── git subprocess ────────────────────────────────────────────────────

function spawnGit(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { stdio: "inherit" });
    proc.on("error", () => resolve(1));
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}
