import { createClient } from "@ideaspaces/sdk";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, saveCredentials } from "../../auth/credentials.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

interface ConnectResult {
  repo_id: string;
  slug: string;
  name: string;
}

interface RepoShapeDetection {
  repoRoot: string;
  originUrl: string;
  normalizedOriginUrl: string;
  markers: {
    purpose: boolean;
    now: boolean;
    accessManifest: boolean;
  };
  classification: "ideaspace_shaped" | "generic" | "ambiguous";
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

function detectRepoFromCwd(cwd: string): RepoShapeDetection {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (inside !== "true") {
      throw new Error("not in a git repo");
    }
  } catch {
    throw new Error("Current directory is not a git repository");
  }

  let repoRoot = "";
  let originUrl = "";

  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Could not resolve git repository root");
  }

  try {
    originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("No git remote named 'origin' found");
  }

  const markers = {
    purpose: existsSync(join(repoRoot, "_agent", "purpose.md")),
    now: existsSync(join(repoRoot, "_agent", "now.md")),
    accessManifest: existsSync(join(repoRoot, "_access", "manifest.yml")),
  };

  let classification: RepoShapeDetection["classification"] = "generic";
  if (markers.purpose && markers.now) {
    classification = "ideaspace_shaped";
  } else if (markers.purpose || markers.now || markers.accessManifest) {
    classification = "ambiguous";
  }

  return {
    repoRoot,
    originUrl,
    normalizedOriginUrl: normalizeConnectOrigin(originUrl),
    markers,
    classification,
  };
}

export const connectCommand: CommandDef = {
  name: "connect",
  description: "Connect an existing git repo to IdeaSpaces",
  usage:
    "ideaspaces power connect [origin_url] [--name NAME] [--slug SLUG] [--hostname HOST] [--from-cwd]",
  examples: [
    "ideaspaces power connect https://github.com/IdeaSpaces-xyz/ideaspace.git --name IdeaSpace",
    "ideaspaces power connect --from-cwd",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 2;
    }

    const fromCwd = Boolean(flags["from-cwd"]);

    let originUrl = (args[0] as string | undefined)?.trim() || "";
    let normalizedOriginUrl = originUrl ? normalizeConnectOrigin(originUrl) : "";
    let name = (flags.name as string | undefined)?.trim() || "";
    let detection: RepoShapeDetection | null = null;

    if (fromCwd || !originUrl) {
      try {
        detection = detectRepoFromCwd(process.cwd());
      } catch (e) {
        output.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      originUrl = detection.originUrl;
      normalizedOriginUrl = detection.normalizedOriginUrl;
      if (!name) name = basename(detection.repoRoot);
    }

    if (!originUrl) {
      output.error("origin_url is required (or use --from-cwd)");
      return 1;
    }

    if (!name) {
      name = deriveNameFromOrigin(normalizedOriginUrl || originUrl);
    }

    const slug = (flags.slug as string | undefined) || undefined;
    const hostname = (flags.hostname as string | undefined) || undefined;

    const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });

    const { data } = (await client.connectRepo({
      origin_url: normalizedOriginUrl || originUrl,
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
        normalized_origin_url: normalizedOriginUrl || originUrl,
        from_cwd: fromCwd || !args[0],
        repo_root: detection?.repoRoot || null,
        markers: detection?.markers || null,
        classification: detection?.classification || null,
      },
    };

    const lines = [
      `Connected: ${data.name} (${data.repo_id})`,
      `Slug: ${data.slug}`,
      `Origin: ${normalizedOriginUrl || originUrl}`,
    ];

    if (detection) {
      lines.push(`Repo root: ${detection.repoRoot}`);
      lines.push(`Classification: ${detection.classification}`);
      lines.push(
        `Markers: purpose=${detection.markers.purpose}, now=${detection.markers.now}, _access=${detection.markers.accessManifest}`,
      );
    }

    output.result(result, lines.join("\n"));
    return 0;
  },
};
