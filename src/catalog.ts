/**
 * Local working-set and repository-catalog orchestration.
 *
 * The protocol reads root handles/repositories, projects them through Map
 * members, and owns canonical row rendering. The CLI supplies only private
 * root ordinals plus harness presentation: home/mount/POV roles, sync state,
 * display paths, caps, and the already-fetched pullable tier.
 */

import { basename, resolve as resolvePath } from "node:path";
import {
  gitState,
  projectRootMapMembers,
  readRootHandle,
  readWorkspaceRepositories,
  renderRootMapMembers,
  type GitState,
  type RootMapMemberInput,
  type WorkspaceRepository,
} from "@ideaspaces/protocol";

// Generic protocol exclusions plus local harness caches/noise.
export const AUTOCOMPLETE_EXCLUDES = [".git", "node_modules", "backups", ".pi", ".claude"];

export const MAX_CATALOG_REPOS = 20;

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

/** One-line local sync state; presentation only, never Map data. */
export async function readRepoState(repoRoot: string): Promise<string> {
  try {
    return repoState(await gitState(repoRoot));
  } catch {
    return "unknown";
  }
}

function repoState(state: GitState): string {
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
  repository: WorkspaceRepository,
  root: number,
  pov: string | null,
  mounts: ReadonlySet<string>,
): RootMapMemberInput {
  const canonical = resolvePath(repository.git.repoRoot);
  const visible = resolvePath(repository.root);
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

/**
 * Immediate local repositories plus a caller-supplied, already-fetched remote
 * tier. Producer order remains POV/mounts first, then lexical local order;
 * remote entries retain caller order.
 */
export async function formatCatalogSection(
  workspaceFolder: string,
  opts: {
    povRepoRoot: string | null;
    mounts: string[];
    pullable?: Array<{ slug: string; namespace: string }>;
  },
): Promise<string | null> {
  const repositories = await readWorkspaceRepositories(workspaceFolder, {
    excludeDirectories: AUTOCOMPLETE_EXCLUDES,
  });
  const pov = opts.povRepoRoot ? resolvePath(opts.povRepoRoot) : null;
  const mountSet = new Set(opts.mounts.map((mount) => resolvePath(mount)));
  const isPriority = (repository: WorkspaceRepository): boolean => {
    const visible = resolvePath(repository.root);
    const canonical = resolvePath(repository.git.repoRoot);
    return visible === pov || canonical === pov || mountSet.has(visible) || mountSet.has(canonical);
  };
  const priority = repositories.filter(isPriority);
  const ordered = [
    ...priority,
    ...repositories.filter((repository) => !isPriority(repository)),
  ];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = repositories.length - shown.length;

  const blocks: string[] = [];
  const local = renderRootMapMembers(
    projectRootMapMembers(
      shown.map((repository, index) =>
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
