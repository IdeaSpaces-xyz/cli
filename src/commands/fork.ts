import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  getSpace,
  getSpaceCopySnapshot,
  UnauthorizedError,
  type PublicApiConfig,
  type PublicSpaceResult,
} from "../auth/api.js";
import { loadOptionalAuthConfig } from "../auth/credentials.js";
import {
  findSpaceFor,
  saveSpace,
  type UnpublishedForkRecord,
} from "../auth/spaces.js";
import {
  loadForkBaseline,
  removeForkBaseline,
  saveForkBaseline,
  type ForkSourceBaseline,
} from "../fork-update.js";
import { prepareForkSnapshot } from "../fork-snapshot.js";
import { gitAvailability, sanitizedGitEnvironment } from "../git.js";
import { createOutput } from "../output.js";
import { mintDeclaredRootIdentity } from "../root-identity.js";
import { canonicalSpaceUrl, parseSpaceLocator } from "../space-locator.js";
import { gitignoreWithDefaults } from "../templates/default.js";
import type { CommandDef } from "../types.js";
import { slugify } from "./publish.js";

const FOUNDATION_PATH = "_agent/foundation.md";
const IMPORT_NAME = "IdeaSpaces Import";
const IMPORT_EMAIL = "import@ideaspaces";
const IMPORT_COMMIT = "Import Space fork";

function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateSource(value: unknown, rootNodeId: string): PublicSpaceResult {
  if (
    !value ||
    typeof value !== "object" ||
    (value as PublicSpaceResult).kind !== "space" ||
    (value as PublicSpaceResult).node_id !== rootNodeId ||
    (value as PublicSpaceResult).container_node_id !== rootNodeId ||
    typeof (value as PublicSpaceResult).name !== "string" ||
    !(value as PublicSpaceResult).name.trim() ||
    typeof (value as PublicSpaceResult).copy_enabled !== "boolean"
  ) {
    throw new Error("The source returned an invalid Space description");
  }
  return value as PublicSpaceResult;
}

async function optionalAuthRead<T>(
  config: PublicApiConfig,
  read: (current: PublicApiConfig) => Promise<T>,
): Promise<{ value: T; config: PublicApiConfig }> {
  try {
    return { value: await read(config), config };
  } catch (err) {
    // A stale ambient token must not make an otherwise-public Space unreadable.
    // Retry once without auth; a private direct-Fork source then fails neutrally.
    if (err instanceof UnauthorizedError && config.apiKey) {
      const anonymous = { apiUrl: config.apiUrl };
      return { value: await read(anonymous), config: anonymous };
    }
    throw err;
  }
}

function sourceReadError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/→ (?:401|403|404):/.test(detail)) {
    return "This Space is unavailable for local Fork. It may be private or not copyable.";
  }
  return `The Space could not be read: ${detail}`;
}

function runGit(cwd: string, args: string[], importIdentity = false): string {
  const env = sanitizedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    ...(importIdentity
      ? {
          GIT_AUTHOR_NAME: IMPORT_NAME,
          GIT_AUTHOR_EMAIL: IMPORT_EMAIL,
          GIT_COMMITTER_NAME: IMPORT_NAME,
          GIT_COMMITTER_EMAIL: IMPORT_EMAIL,
        }
      : {}),
  });
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim(),
    );
  }
  return (result.stdout ?? "").trim();
}

function destinationRootIdentity(
  markdown: Record<string, string>,
  sourceRootNodeId: string,
): { markdown: Record<string, string>; rootNodeId: string } {
  const foundation = markdown[FOUNDATION_PATH];
  if (!foundation) {
    throw new Error("The projected Space has no root _agent/foundation.md to carry identity");
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const declared = mintDeclaredRootIdentity(foundation);
    if (declared.rootNodeId !== sourceRootNodeId) {
      return {
        markdown: { ...markdown, [FOUNDATION_PATH]: declared.content },
        rootNodeId: declared.rootNodeId,
      };
    }
  }
  throw new Error("Could not mint a destination identity distinct from the source");
}

function writeTree(
  root: string,
  markdown: Record<string, string>,
  assets: Array<{ path: string; content: Buffer }>,
): void {
  for (const [path, content] of Object.entries(markdown)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, { encoding: "utf-8", flag: "wx" });
  }
  for (const asset of assets) {
    const absolute = join(root, asset.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, asset.content, { flag: "wx" });
  }
  const ignore = gitignoreWithDefaults(null, { privateAgent: false });
  if (ignore === null) throw new Error("Could not prepare local-only ignore rules");
  writeFileSync(join(root, ".gitignore"), ignore, { encoding: "utf-8", flag: "wx" });
}

function initializeImport(root: string): void {
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["-c", "core.autocrlf=false", "add", "-A", "--", "."]);
  runGit(
    root,
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", IMPORT_COMMIT],
    true,
  );
  if (runGit(root, ["status", "--porcelain"])) {
    throw new Error("The imported repository is not clean after its initial commit");
  }
  if (runGit(root, ["rev-list", "--count", "HEAD"]) !== "1") {
    throw new Error("The imported repository does not have exactly one commit");
  }
  if (runGit(root, ["symbolic-ref", "--short", "HEAD"]) !== "main") {
    throw new Error("The imported repository did not initialize on main");
  }
  if (runGit(root, ["remote"])) {
    throw new Error("The imported repository unexpectedly has a remote");
  }
}

function preflightDestination(path: string): string | null {
  if (existsSync(path)) return `${path} already exists. Choose another destination folder.`;
  if (findSpaceFor(path)) {
    return `${path} still has a local Space registry record. Forget or repair that state before reusing the path.`;
  }
  try {
    if (loadForkBaseline(path)) {
      return `${path} still has a fork update baseline. Choose another destination or remove the stale local state.`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const parent = dirname(path);
  try {
    if (!statSync(parent).isDirectory()) return `${parent} is not a directory.`;
  } catch {
    return `Parent directory does not exist: ${parent}`;
  }
  return null;
}

function installLocalFork(opts: {
  destination: string;
  name: string;
  sourceRootNodeId: string;
  sourceHead: string;
  rootNodeId: string;
  markdown: Record<string, string>;
  assets: Array<{ path: string; content: Buffer }>;
}): void {
  const { destination, name, sourceRootNodeId, sourceHead, rootNodeId, markdown, assets } = opts;
  const parent = dirname(destination);
  let temporary: string | null = null;
  let installed = false;
  let baselineSaved = false;
  try {
    temporary = mkdtempSync(join(parent, `.${basename(destination)}.ideaspaces-fork-`));
    writeTree(temporary, markdown, assets);
    initializeImport(temporary);
    if (existsSync(destination)) throw new Error(`${destination} appeared while the fork was being prepared`);
    renameSync(temporary, destination);
    temporary = null;
    installed = true;

    const baseline: ForkSourceBaseline = {
      source_root_node_id: sourceRootNodeId,
      source_head: sourceHead,
      files: markdown,
      conflicts: [],
    };
    saveForkBaseline(destination, baseline);
    baselineSaved = true;
    const record: UnpublishedForkRecord = {
      kind: "unpublished_fork",
      root_node_id: rootNodeId,
      name,
      source_root_node_id: sourceRootNodeId,
      source_head: sourceHead,
      source_baseline_initialized: true,
    };
    saveSpace(destination, record);
  } catch (err) {
    if (baselineSaved) {
      try {
        removeForkBaseline(destination);
      } catch {
        // Preserve the original failure; the destination rollback still matters most.
      }
    }
    if (installed) rmSync(destination, { recursive: true, force: true });
    throw err;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export const forkCommand: CommandDef = {
  name: "fork",
  description: "Materialize an independent local Space without source history or an account",
  usage: "ideaspaces fork <space-url> [dir] [--name <local-name>]",
  examples: [
    "ideaspaces fork https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567",
    "ideaspaces fork https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567 ./manual",
    "ideaspaces fork https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567 ./manual --name \"My manual\"",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const target = args[0];
    if (!target || args.length > 2) {
      output.error("Usage: ideaspaces fork <space-url> [dir] [--name <local-name>]");
      return 1;
    }
    if (flags.location !== undefined || flags.slug !== undefined) {
      output.error(
        "`fork` is local-only. --location and --slug are no longer accepted; choose hosting later with `ideaspaces publish --hostname/--slug`.",
      );
      return 1;
    }
    if (flags.name === true || (typeof flags.name === "string" && !flags.name.trim())) {
      output.error("--name requires a non-empty local display name.");
      return 1;
    }

    const availability = gitAvailability();
    if (availability.state !== "usable") {
      output.error(availability.hint);
      return 1;
    }

    const initialConfig = loadOptionalAuthConfig();
    let sourceRootNodeId: string;
    try {
      sourceRootNodeId = parseSpaceLocator(target, initialConfig.apiUrl).rootNodeId;
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const explicitDestination = args[1] ? resolve(args[1]) : null;
    if (explicitDestination) {
      const problem = preflightDestination(explicitDestination);
      if (problem) {
        output.error(problem);
        return 1;
      }
    }

    output.progress(`Reading ${canonicalSpaceUrl(initialConfig.apiUrl, sourceRootNodeId)}…`);
    let source: PublicSpaceResult;
    let readConfig: PublicApiConfig;
    try {
      const read = await optionalAuthRead(initialConfig, (config) =>
        getSpace(config, sourceRootNodeId, { timeoutMs: 120_000 }),
      );
      source = validateSource(read.value, sourceRootNodeId);
      readConfig = read.config;
    } catch (err) {
      output.error(sourceReadError(err));
      return 1;
    }
    if (!source.copy_enabled) {
      output.error("This Space is unavailable for local Fork. It may be private or not copyable.");
      return 1;
    }

    const name = stringFlag(flags, "name") ?? source.name.trim();
    const destination = explicitDestination ?? resolve(slugify(name));
    if (!explicitDestination) {
      const problem = preflightDestination(destination);
      if (problem) {
        output.error(problem);
        return 1;
      }
    }

    output.progress("Reading the complete history-free snapshot…");
    let snapshot: Awaited<ReturnType<typeof getSpaceCopySnapshot>>;
    try {
      const read = await optionalAuthRead(readConfig, (config) =>
        getSpaceCopySnapshot(config, sourceRootNodeId, { timeoutMs: 120_000 }),
      );
      snapshot = read.value;
    } catch (err) {
      output.error(sourceReadError(err));
      return 1;
    }

    let prepared;
    let destinationIdentity;
    try {
      prepared = prepareForkSnapshot(snapshot);
      destinationIdentity = destinationRootIdentity(prepared.markdown, sourceRootNodeId);
    } catch (err) {
      output.error(
        `The source projection could not be validated; no local files were changed. ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    try {
      installLocalFork({
        destination,
        name,
        sourceRootNodeId,
        sourceHead: prepared.sourceHead,
        rootNodeId: destinationIdentity.rootNodeId,
        markdown: destinationIdentity.markdown,
        assets: prepared.assets,
      });
    } catch (err) {
      output.error(
        `The local Fork could not be installed; no destination was kept. ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    output.result(
      {
        kind: "unpublished_fork",
        path: destination,
        name,
        root_node_id: destinationIdentity.rootNodeId,
        source_root_node_id: sourceRootNodeId,
        source_head: prepared.sourceHead,
        markdown_file_count: prepared.markdownFileCount,
        asset_file_count: prepared.assetFileCount,
        source_history_copied: false,
        published: false,
      },
      [
        `Forked current content without source history → ${destination}`,
        `Local Space identity: ${destinationIdentity.rootNodeId}`,
        `Source: ${canonicalSpaceUrl(initialConfig.apiUrl, sourceRootNodeId)} @ ${prepared.sourceHead.slice(0, 12)}`,
        "This Space is local and unpublished. Sign in and run `ideaspaces publish` when you want to host it.",
      ].join("\n"),
    );
    return 0;
  },
};
