/**
 * The repo catalog + working-set awareness sections — the LOCAL tier of a local
 * agent's orientation: which git repos sit beside it in a workspace folder, their
 * sync state, and a thin working-set of the home root plus mounts.
 *
 * Lifted verbatim from the pi-is-space extension so the CLI is the single
 * producer of this section and the agent can shell `navigate` instead of
 * composing it in-process. Match-by-construction is deliberate: the render is
 * lifted unchanged (same strings) and locked with a golden fixture, so the
 * later swap is provable rather than a reimplementation that can drift.
 *
 * Pure composition over two SDK primitives (`extractSummary`, `gitState`) plus
 * filesystem reads; no git side effects.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { extractSummary, gitState } from "@ideaspaces/sdk";

// Noise dirs skipped when scanning a folder for child repos / counting dirs.
export const AUTOCOMPLETE_EXCLUDES = [".git", "node_modules", "backups", ".pi", ".claude"];

// Cap on catalog rows so a folder with many repos can't bloat the awareness
// block; the remainder is summarised as "…and N more".
export const MAX_CATALOG_REPOS = 20;

// A single working-set handle: a root, a one-line summary, and a top-level dir
// count. Mounts surface as thin handles — orientation, not full trees.
type RootHandle = { summary: string | null; dirCount: number | null };

// First line of a file's content (frontmatter stripped via extractSummary), or
// null. Kept to a single line so working-set handles stay terse.
function firstContentLine(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("---")) return trimmed;
  }
  return null;
}

// Read a one-line summary for a root: prefer `_agent/now.md`, then `README.md`.
// Use the Layer 1 frontmatter summary when present, else the first content line.
async function readRootSummary(root: string): Promise<string | null> {
  const candidates = [join(root, "_agent", "now.md"), join(root, "README.md")];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf-8");
      const summary = extractSummary(content) ?? firstContentLine(content);
      if (summary) return summary.replace(/\s+/g, " ").trim();
    } catch {
      // Missing or unreadable candidate — try the next.
    }
  }
  return null;
}

// Count top-level directories under a root, excluding noise dirs. Best-effort.
async function countTopLevelDirs(root: string): Promise<number | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(
      (entry) => entry.isDirectory() && !AUTOCOMPLETE_EXCLUDES.includes(entry.name),
    ).length;
  } catch {
    return null;
  }
}

async function readRootHandle(root: string): Promise<RootHandle> {
  const [summary, dirCount] = await Promise.all([readRootSummary(root), countTopLevelDirs(root)]);
  return { summary, dirCount };
}

function formatRootHandleLine(label: string, display: string, handle: RootHandle): string {
  const parts = [`  ${label}: ${display}`];
  if (handle.summary) parts.push(` — ${handle.summary}`);
  if (handle.dirCount != null) parts.push(` (${handle.dirCount} dirs)`);
  return parts.join("");
}

// The working-set section: the home root (authority frame) plus read-only
// content mounts, each as a thin handle. Progressive disclosure — handles only,
// never full trees; deepen a mount on demand via is_navigate({ root }).
export async function formatWorkingSetSection(homeRoot: string, mounts: string[]): Promise<string | null> {
  const lines = ["Working set:"];
  const homeHandle = await readRootHandle(homeRoot);
  lines.push(formatRootHandleLine("home", basename(homeRoot) || homeRoot, homeHandle));

  const mountHandles = await Promise.all(mounts.map((mount) => readRootHandle(mount)));
  mounts.forEach((mount, index) => {
    lines.push(formatRootHandleLine("mount", mount, mountHandles[index]));
  });

  return lines.join("\n");
}

// One-line sync state for a repo, from gitState: `local-only` (no upstream),
// `synced`, `ahead N`, `behind N`, `diverged +A/-B`; suffixed ` · dirty` when
// the tree is dirty. `unknown` when git state can't be read.
export async function readRepoState(repoRoot: string): Promise<string> {
  let state: Awaited<ReturnType<typeof gitState>>;
  try {
    state = await gitState(repoRoot);
  } catch {
    return "unknown";
  }
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

// The catalog: git repos that are immediate children of the workspace folder
// (the session cwd / `--context` root), each a thin handle tagged with its sync
// state, the POV, and whether it's mounted. This is the LOCAL tier — the repos
// the agent can navigate into or pull; the remote/pullable tier is added when
// IdeaSpace is connected. Repos only: plain dirs are ordinary files the agent
// reads directly. Returns null when the folder holds no child repos. Immediate
// children only (repos are siblings), not recursive; capped and rendered in
// parallel across repos.
export async function formatCatalogSection(
  workspaceFolder: string,
  opts: {
    povRepoRoot: string | null;
    mounts: string[];
    pullable?: Array<{ slug: string; namespace: string }>;
  },
): Promise<string | null> {
  let repos: string[];
  try {
    const entries = await readdir(workspaceFolder, { withFileTypes: true });
    repos = entries
      .filter((entry) => entry.isDirectory() && !AUTOCOMPLETE_EXCLUDES.includes(entry.name))
      .map((entry) => join(workspaceFolder, entry.name))
      .filter((dir) => existsSync(join(dir, ".git")));
  } catch {
    // Unreadable folder: no local tier, but the pullable tier may still render.
    repos = [];
  }
  repos.sort((a, b) => basename(a).localeCompare(basename(b)));

  const pov = opts.povRepoRoot ? resolvePath(opts.povRepoRoot) : null;
  const mountSet = new Set(opts.mounts.map((mount) => resolvePath(mount)));
  // Keep the POV and mounted repos in view even past the cap — the agent's own
  // position must never be the row that gets truncated. Priority repos first,
  // the rest alphabetically, then slice (never below the priority count).
  const isPriority = (repo: string): boolean => {
    const abs = resolvePath(repo);
    return abs === pov || mountSet.has(abs);
  };
  const priority = repos.filter(isPriority);
  const ordered = [...priority, ...repos.filter((repo) => !isPriority(repo))];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = repos.length - shown.length;

  const rows = await Promise.all(
    shown.map(async (repo) => {
      const [summary, state] = await Promise.all([readRootSummary(repo), readRepoState(repo)]);
      const tags = [state];
      if (pov && resolvePath(repo) === pov) tags.push("POV");
      if (mountSet.has(resolvePath(repo))) tags.push("mounted");
      const parts = [`  ${basename(repo)}`];
      if (summary) parts.push(` — ${summary}`);
      parts.push(` (${tags.join(" · ")})`);
      return parts.join("");
    }),
  );

  const blocks: string[] = [];
  if (rows.length) {
    const lines = ["Repos in scope (local):", ...rows];
    if (overflow > 0) lines.push(`  …and ${overflow} more`);
    blocks.push(lines.join("\n"));
  }
  // The remote/pullable tier: account spaces not yet on disk (from the CLI
  // `catalog` verb). Empty when logged out. Pull one to bring it local.
  const pullable = opts.pullable ?? [];
  if (pullable.length) {
    blocks.push(
      [
        "Pullable (remote — not yet local):",
        ...pullable.map((p) => `  ${p.slug} (${p.namespace})`),
        "  → to work on one, clone it into this folder with `ideaspaces clone` (via bash).",
      ].join("\n"),
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
}
