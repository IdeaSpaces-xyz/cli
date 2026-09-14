/**
 * Local working-set and repository-catalog orchestration.
 *
 * The protocol reads root handles, projects them through Map members, and owns
 * canonical row rendering. The CLI supplies only a cheap capped workspace scan,
 * private root ordinals, and harness presentation: home/mount/POV roles, sync
 * state, display paths, and the already-fetched pullable tier.
 */

import { existsSync } from "node:fs";
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
