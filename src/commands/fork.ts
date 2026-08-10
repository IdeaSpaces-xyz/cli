import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  copySpace,
  fetchAuthMe,
  getSpace,
  UnauthorizedError,
  type AuthMeRepo,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { saveSpace, type SpaceRecord } from "../auth/spaces.js";
import { cloneRepo, setLocalConfig } from "../git.js";
import { createOutput } from "../output.js";
import {
  canonicalGitUrl,
  canonicalSpaceUrl,
  parseSpaceLocator,
  spaceRecordForRepo,
} from "../space-locator.js";
import type { CommandDef } from "../types.js";

function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fallbackRecord(
  result: { repo_id: string; root_node_id: string; slug: string },
  namespace: string,
): SpaceRecord {
  return {
    repo_id: result.repo_id,
    root_node_id: result.root_node_id,
    slug: result.slug,
    namespace,
    route_status: "unavailable",
    route_namespace: null,
    route_slug: null,
    canonical_path: `/spaces/${result.root_node_id}`,
  };
}

export const forkCommand: CommandDef = {
  name: "fork",
  description: "Create and clone an independent, history-free Space copy",
  usage: "ideaspaces fork <space-url> [dir] [--location personal|<team-hostname>] [--name <name>] [--slug <slug>]",
  examples: [
    "ideaspaces fork https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567",
    "ideaspaces fork https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567 ./manual --location acme.com",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const target = args[0];
    if (!target) {
      output.error("Usage: ideaspaces fork <space-url> [dir] [--location personal|<team-hostname>]");
      return 1;
    }

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    let sourceRoot: string;
    try {
      sourceRoot = parseSpaceLocator(target, config.apiUrl).rootNodeId;
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const location = stringFlag(flags, "location") ?? "personal";
    const hostname = location === "personal" ? null : location;
    if (flags.location === true || flags.name === true || flags.slug === true) {
      output.error("--location, --name, and --slug require values when provided.");
      return 1;
    }
    const requestedDir = args[1] ? resolve(args[1]) : undefined;
    if (requestedDir && existsSync(requestedDir)) {
      output.error(`${requestedDir} already exists. Choose another destination folder.`);
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

    let source;
    try {
      source = await getSpace(config, sourceRoot);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (!source.copy_enabled) {
      output.error("This Space does not allow an independent copy for your account.");
      return 1;
    }

    const name = stringFlag(flags, "name") ?? source.name;
    const slug = stringFlag(flags, "slug");
    output.progress(`Creating an independent copy of ${canonicalSpaceUrl(config.apiUrl, sourceRoot)}…`);

    let copied;
    try {
      copied = await copySpace(
        config,
        sourceRoot,
        {
          name,
          ...(slug ? { slug } : {}),
          hostname,
        },
        { timeoutMs: 120_000 },
      );
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Typed as required, but the response is cast rather than validated. A
    // server that omits it must leave the pin unrecorded — an update path
    // reading a blank commit is worse than one that reports no pin at all.
    const pinnedHead =
      typeof copied.source_head === "string" && copied.source_head.trim()
        ? copied.source_head.trim()
        : null;

    const destinationUrl = canonicalSpaceUrl(config.apiUrl, copied.root_node_id);
    const remoteUrl = canonicalGitUrl(config.apiUrl, copied.root_node_id);
    const dir = requestedDir ?? resolve(copied.slug);
    if (existsSync(dir)) {
      output.error(
        `Fork created at ${destinationUrl}, but ${dir} already exists. ` +
          `Clone the new Space into another folder with \`ideaspaces clone ${destinationUrl} <dir>\`.`,
      );
      return 1;
    }

    await registerGitCredentialHelper();
    output.progress(`Cloning new Space into ${dir}…`);
    try {
      cloneRepo(remoteUrl, dir);
    } catch (err) {
      output.error(
        `Fork created at ${destinationUrl}, but cloning failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Retry with \`ideaspaces clone ${destinationUrl} <dir>\`; do not repeat fork.`,
      );
      return 1;
    }

    let destinationRepo: AuthMeRepo | undefined;
    try {
      const refreshed = await fetchAuthMe(config);
      destinationRepo = refreshed.repos.find((repo) => repo.repo_id === copied.repo_id);
    } catch {
      output.log("Fork succeeded, but current route metadata could not be refreshed; stable Space identity was saved.");
    }

    const namespace = hostname ?? me.username ?? "";
    // The clone's remote is the copy's own. Record where it came from and at
    // what commit, or nothing downstream can ever offer an update.
    const record: SpaceRecord = {
      ...(destinationRepo
        ? spaceRecordForRepo(destinationRepo, me.username)
        : fallbackRecord(copied, namespace)),
      source_root_node_id: sourceRoot,
      ...(pinnedHead ? { source_head: pinnedHead } : {}),
    };
    try {
      saveSpace(dir, record);
    } catch {
      output.error(
        `Fork and clone succeeded at ${destinationUrl}, but the local registry could not be updated. ` +
          "Run `ideaspaces link` from this clone to repair the binding.",
      );
      return 1;
    }

    if (me.username) {
      try {
        setLocalConfig("user.email", identityEmail(me.username), dir);
        setLocalConfig("user.name", identityName({ name: me.name, username: me.username }), dir);
      } catch {
        // Non-fatal — commit re-ensures the authenticated identity.
      }
    }

    output.result(
      {
        source_root_node_id: sourceRoot,
        source_head: pinnedHead,
        repo_id: copied.repo_id,
        root_node_id: copied.root_node_id,
        slug: copied.slug,
        route_status: record.route_status ?? null,
        route_namespace: record.route_namespace ?? null,
        route_slug: record.route_slug ?? null,
        space_url: destinationUrl,
        remote_url: remoteUrl,
        source_history_copied: false,
        index_status: copied.index_status,
        path: dir,
      },
      [
        `Forked current content without source history → ${dir}`,
        `Space: ${destinationUrl}`,
        copied.index_status === "unindexed"
          ? "Content is cloned; hosted indexing needs recovery."
          : "Hosted index is fresh.",
      ].join("\n"),
    );
    return 0;
  },
};
