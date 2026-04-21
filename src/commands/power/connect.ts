import { createClient } from "@ideaspaces/sdk";
import { loadConfig, saveCredentials } from "../../auth/credentials.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

/**
 * `ideaspaces power connect <origin_url>` — adopt an external git repo
 * (GitHub, GitLab, etc.) as an IdeaSpaces space.
 *
 * For creating a *new* space where IdeaSpaces is the origin, use
 * `ideaspaces init`. The `--from-cwd` shortcut that auto-detected the
 * cwd's origin was removed when init landed — it was designed for the
 * pre-git-push world where every local repo needed a server-side copy.
 * Today, `init` handles the "make my cwd a space" case cleanly.
 */

interface ConnectResult {
  repo_id: string;
  slug: string;
  name: string;
}

function deriveNameFromOrigin(originUrl: string): string {
  const withoutQuery = originUrl.split(/[?#]/, 1)[0];
  const last = withoutQuery.split("/").pop() || "connected-repo";
  return last.replace(/\.git$/i, "") || "connected-repo";
}

export function normalizeConnectOrigin(originUrl: string): string {
  const trimmed = originUrl.trim();

  // git@github.com:org/repo.git -> https://github.com/org/repo.git
  const scpLike = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (scpLike) {
    return `https://${scpLike[1]}/${scpLike[2]}`;
  }

  // ssh://git@github.com/org/repo.git -> https://github.com/org/repo.git
  const sshLike = /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(trimmed);
  if (sshLike) {
    return `https://${sshLike[1]}/${sshLike[2]}`;
  }

  return trimmed;
}

export const connectCommand: CommandDef = {
  name: "connect",
  description: "Adopt an external git repo (GitHub, GitLab, …) as an IdeaSpaces space",
  usage:
    "ideaspaces power connect <origin_url> [--name NAME] [--slug SLUG] [--hostname HOST]",
  examples: [
    "ideaspaces power connect https://github.com/IdeaSpaces-xyz/ideaspace.git --name IdeaSpace",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 2;
    }

    const originUrl = (args[0] as string | undefined)?.trim() || "";
    if (!originUrl) {
      output.error(
        "origin_url is required. For a brand-new space, use 'ideaspaces init <name>' instead.",
      );
      return 1;
    }
    const normalizedOriginUrl = normalizeConnectOrigin(originUrl);

    let name = (flags.name as string | undefined)?.trim() || "";
    if (!name) {
      name = deriveNameFromOrigin(normalizedOriginUrl);
    }

    const slug = (flags.slug as string | undefined) || undefined;
    const hostname = (flags.hostname as string | undefined) || undefined;

    const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });

    const { data } = (await client.connectRepo({
      origin_url: normalizedOriginUrl,
      name,
      slug,
      hostname: hostname ?? null,
    })) as { data: ConnectResult };

    if (!process.env.IS_API_KEY) {
      saveCredentials({
        api_url: config.apiUrl,
        api_key: config.apiKey,
        repo_id: data.repo_id,
      });
    }

    const result = {
      repo: data,
      source: {
        origin_url: originUrl,
        normalized_origin_url: normalizedOriginUrl,
      },
    };

    const lines = [
      `Connected: ${data.name} (${data.repo_id})`,
      `Slug: ${data.slug}`,
      `Origin: ${normalizedOriginUrl}`,
    ];

    output.result(result, lines.join("\n"));
    return 0;
  },
};
