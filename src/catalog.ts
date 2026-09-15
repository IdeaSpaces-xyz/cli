/**
 * Local working-set and repository-catalog orchestration.
 *
 * The protocol reads root handles, projects them through Map members, and owns
 * canonical row rendering. The CLI supplies only a cheap capped workspace scan,
 * private root ordinals, and harness presentation: home/mount/POV roles, sync
 * state, display paths, and the already-fetched pullable tier.
 */

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import {
  gitState,
  projectRootMapMembers,
  readRootHandle,
  renderRootMapMembers,
  type GitState,
  type RootMapMemberInput,
} from "@ideaspaces/protocol";

// Generic protocol exclusions plus local harness caches/noise.
export const AUTOCOMPLETE_EXCLUDES = [".git", "node_modules", "backups", ".pi", ".claude"];

export const MAX_CATALOG_REPOS = 20;

interface CatalogRepository {
  root: string;
  summary: string | null;
  git: GitState | null;
}

function directoryDetails(count: number | null): string[] {
  return count == null ? [] : [`${count} dirs`];
}

/** Thin authority root followed by caller-ordered read-only mounts. */
export async function formatWorkingSetSection(
  homeRoot: string,
  mounts: string[],
): Promise<string | null> {
  const options = { excludeDirectories: AUTOCOMPLETE_EXCLUDES };
  const [home, ...mounted] = await Promise.all([
    readRootHandle(homeRoot, options),
    ...mounts.map((mount) => readRootHandle(mount, options)),
  ]);
  const inputs: RootMapMemberInput[] = [
    {
      root: 0,
      name: basename(homeRoot) || homeRoot,
      summary: home.summary,
      presentation: {
        label: "home",
        display: basename(homeRoot) || homeRoot,
        details: directoryDetails(home.directoryCount),
      },
    },
    ...mounts.map((mount, index): RootMapMemberInput => ({
      root: index + 1,
      name: basename(mount) || mount,
      summary: mounted[index]?.summary,
      presentation: {
        label: "mount",
        display: mount,
        details: directoryDetails(mounted[index]?.directoryCount ?? null),
      },
    })),
  ];
  return renderRootMapMembers(projectRootMapMembers(inputs), {
    heading: "Working set:",
  });
}

function repoState(state: GitState | null): string {
  if (!state) return "unknown";
  let base: string;
  if (state.ahead == null || state.behind == null) {
    base = "local-only";
  } else if (state.ahead > 0 && state.behind > 0) {
    base = `diverged +${state.ahead}/-${state.behind}`;
  } else if (state.ahead > 0) {
    base = `ahead ${state.ahead}`;
  } else if (state.behind > 0) {
    base = `behind ${state.behind}`;
  } else {
    base = "synced";
  }
  return state.dirty ? `${base} · dirty` : base;
}

function catalogInput(
  repository: CatalogRepository,
  root: number,
  pov: string | null,
  mounts: ReadonlySet<string>,
): RootMapMemberInput {
  const visible = resolvePath(repository.root);
  const canonical = repository.git ? resolvePath(repository.git.repoRoot) : visible;
  const details = [repoState(repository.git)];
  if (pov && (visible === pov || canonical === pov)) details.push("POV");
  if (mounts.has(visible) || mounts.has(canonical)) details.push("mounted");
  return {
    root,
    name: basename(repository.root) || repository.root,
    summary: repository.summary,
    presentation: {
      display: basename(repository.root) || repository.root,
      details,
    },
  };
}

async function catalogCandidates(workspaceFolder: string): Promise<string[]> {
  try {
    const entries = await readdir(workspaceFolder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !AUTOCOMPLETE_EXCLUDES.includes(entry.name))
      .map((entry) => join(workspaceFolder, entry.name))
      // This is intentionally only the cheap pre-cap candidate test. Full Git
      // facts and root handles are read for displayed rows below.
      .filter((root) => existsSync(join(root, ".git")))
      .sort((left, right) => basename(left).localeCompare(basename(right)));
  } catch {
    return [];
  }
}

/**
 * Immediate local repositories plus a caller-supplied, already-fetched remote
 * tier. Producer order remains POV/mounts first, then lexical local order;
 * remote entries retain caller order. Expensive per-repository reads happen
 * only after the local display cap is applied.
 */
export async function formatCatalogSection(
  workspaceFolder: string,
  opts: {
    povRepoRoot: string | null;
    mounts: string[];
    pullable?: Array<{ slug: string; namespace: string }>;
  },
): Promise<string | null> {
  const candidates = await catalogCandidates(workspaceFolder);
  const pov = opts.povRepoRoot ? resolvePath(opts.povRepoRoot) : null;
  const mountSet = new Set(opts.mounts.map((mount) => resolvePath(mount)));
  const isPriority = (root: string): boolean => {
    const visible = resolvePath(root);
    return visible === pov || mountSet.has(visible);
  };
  const priority = candidates.filter(isPriority);
  const ordered = [
    ...priority,
    ...candidates.filter((root) => !isPriority(root)),
  ];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = candidates.length - shown.length;
  const options = { excludeDirectories: AUTOCOMPLETE_EXCLUDES };
  const repositories = await Promise.all(
    shown.map(async (root): Promise<CatalogRepository> => {
      const [handle, state] = await Promise.all([
        readRootHandle(root, options),
        gitState(root).catch(() => null),
      ]);
      return { root, summary: handle.summary, git: state };
    }),
  );

  const blocks: string[] = [];
  const local = renderRootMapMembers(
    projectRootMapMembers(
      repositories.map((repository, index) =>
        catalogInput(repository, index, pov, mountSet),
      ),
    ),
    { heading: "Repos in scope (local):", omittedMembers: overflow },
  );
  if (local) blocks.push(local);

  const pullable = opts.pullable ?? [];
  const remote = renderRootMapMembers(
    projectRootMapMembers(
      pullable.map((entry): RootMapMemberInput => ({
        name: entry.slug,
        presentation: { details: [entry.namespace] },
      })),
    ),
    { heading: "Pullable (remote — not yet local):" },
  );
  if (remote) {
    blocks.push(
      `${remote}\n  → to work on one, clone it into this folder with \`ideaspaces clone\` (via bash).`,
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

// Harness copy, not protocol shape: these name the CLI's own navigation verbs.
export const BARE_WORKSPACE_HINT =
  "You're at a workspace folder (no `_agent/` contract here). Navigate into a repo below (`ideaspaces navigate <repo>`), or pull one that's behind.";
export const EMPTY_WORKSPACE_HINT =
  "You're at a workspace folder with no repos yet. Clone one to get started (`ideaspaces clone`).";

// Parse --pullable: a comma-separated list of `slug:namespace` pairs — the
// remote/pullable tier the caller already fetched via `catalog` (kept out of
// orientation so it stays network-free). The flag parser has no arrays, hence
// the string encoding; entries without a colon are dropped, not half-rendered.
export function parsePullable(raw: string | boolean | undefined): Array<{ slug: string; namespace: string }> {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      return i > 0 ? { slug: p.slice(0, i), namespace: p.slice(i + 1) } : null;
    })
    .filter((x): x is { slug: string; namespace: string } => x !== null);
}

export type CatalogPlan =
  | { kind: "none" }
  | { kind: "warn"; text: string }
  | { kind: "ok"; mounts: string[]; catalog: Promise<string | null> };

// Resolve --workspace and **start** rendering the local-agent repo catalog
// (local + pullable tiers). Synchronous — it returns the in-flight promise so the
// caller can await it alongside the awareness assembly (independent IO, run
// concurrently). Independent of the `_agent/` contract, so the catalog renders
// at a bare folder too. Warning for an unreadable --workspace; none when the
// flag is absent.
export function planCatalog(flags: Record<string, string | boolean>, povRepoRoot: string | null): CatalogPlan {
  const workspace = typeof flags.workspace === "string" ? resolvePath(flags.workspace) : null;
  if (!workspace) return { kind: "none" };
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    // A typo'd --workspace would otherwise look identical to "no repos here" —
    // surface it as a drift line rather than silently rendering nothing.
    return { kind: "warn", text: `⚠ --workspace is not a readable directory: ${workspace} (catalog skipped)` };
  }
  const mounts =
    typeof flags.mount === "string" ? flags.mount.split(",").map((m) => m.trim()).filter(Boolean) : [];
  const catalog = formatCatalogSection(workspace, { povRepoRoot, mounts, pullable: parsePullable(flags.pullable) });
  return { kind: "ok", mounts, catalog };
}

/** The floor hint for a bare workspace folder: only when no repo and no contract resolve. */
export function floorHint(catalog: string | null): string {
  return catalog ? BARE_WORKSPACE_HINT : EMPTY_WORKSPACE_HINT;
}
