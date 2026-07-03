/**
 * `ideaspaces catalog` — one consolidated view of the account's repos, joining
 * the server list (`/auth/me`), the local clone registry (`spaces.json`), and
 * per-clone git state into a single tagged catalog.
 *
 * Auth-optional: logged out it emits the local clones only; logged in it adds
 * the remote/pullable tier. Structured data, not presentation — consumers (the
 * desktop rail, the local agent's awareness) format the state vocabulary
 * themselves; the `--json` output carries raw `ahead`/`behind`/`dirty`.
 */

import { gitState } from "@ideaspaces/sdk";
import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import type { AuthMeRepo, AuthMeResponse } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { loadSpaces } from "../auth/spaces.js";
import type { SpaceRecord } from "../auth/spaces.js";
import { fetch as gitFetch } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

/** Where a repo lives relative to this machine + account. */
export type RepoLocation = "online-only" | "available" | "local-only";

/** Per-clone git state, or a marker that git state couldn't be read. */
export type RepoStatus =
  | { branch: string | null; ahead: number | null; behind: number | null; dirty: boolean }
  | { failed: true };

/** A clone's registry binding plus its absolute folder path. */
export interface CloneEntry {
  path: string;
  record: SpaceRecord;
}

/** A consolidated catalog row: identity + location + (when on disk) sync state. */
export interface CatalogEntry {
  repo_id: string;
  slug: string;
  hostname: string | null;
  namespace: string;
  role?: string;
  member_count?: number;
  location: RepoLocation;
  clone?: { path: string };
  sync?: { branch: string | null; ahead: number | null; behind: number | null; dirty: boolean };
  statusFailed?: boolean;
}

/**
 * Join the server repo list, the local clones, and per-clone git state into one
 * catalog. Pure — all IO happens in the command. `me` is null when logged out,
 * which drops the remote tier: every clone is then reported as `available`,
 * since without the server list we can't tell an orphan from a known space.
 */
export function deriveCatalog(
  me: { username: string | null; repos: AuthMeRepo[] } | null,
  clones: CloneEntry[],
  statusByPath: Map<string, RepoStatus>,
): CatalogEntry[] {
  const syncOf = (path: string): Pick<CatalogEntry, "sync" | "statusFailed"> => {
    const st = statusByPath.get(path);
    if (!st) return {};
    if ("failed" in st) return { statusFailed: true };
    return { sync: { branch: st.branch, ahead: st.ahead, behind: st.behind, dirty: st.dirty } };
  };

  if (!me) {
    return clones.map((c) => ({
      repo_id: c.record.repo_id,
      slug: c.record.slug,
      hostname: null,
      namespace: c.record.namespace,
      location: "available" as const,
      clone: { path: c.path },
      ...syncOf(c.path),
    }));
  }

  const clonesByRepo = new Map<string, CloneEntry[]>();
  for (const c of clones) {
    const list = clonesByRepo.get(c.record.repo_id) ?? [];
    list.push(c);
    clonesByRepo.set(c.record.repo_id, list);
  }

  const entries: CatalogEntry[] = [];
  const used = new Set<string>();
  for (const repo of me.repos) {
    const namespace = repo.hostname ?? me.username ?? "";
    const matching = clonesByRepo.get(repo.repo_id) ?? [];
    if (matching.length === 0) {
      entries.push({
        repo_id: repo.repo_id,
        slug: repo.slug,
        hostname: repo.hostname,
        namespace,
        role: repo.role,
        member_count: repo.member_count,
        location: "online-only",
      });
      continue;
    }
    for (const c of matching) {
      used.add(c.path);
      entries.push({
        repo_id: repo.repo_id,
        slug: repo.slug,
        hostname: repo.hostname,
        namespace,
        role: repo.role,
        member_count: repo.member_count,
        location: "available",
        clone: { path: c.path },
        ...syncOf(c.path),
      });
    }
  }
  // Clones bound to a repo the account can't see — orphans.
  for (const c of clones) {
    if (used.has(c.path)) continue;
    entries.push({
      repo_id: c.record.repo_id,
      slug: c.record.slug,
      hostname: null,
      namespace: c.record.namespace,
      location: "local-only",
      clone: { path: c.path },
      ...syncOf(c.path),
    });
  }
  return entries;
}

/** Human-facing sync label for a catalog row (presentation only). */
function stateLabel(entry: CatalogEntry): string {
  if (entry.statusFailed) return "status unknown";
  if (!entry.sync) return "";
  const { ahead, behind, dirty } = entry.sync;
  let base: string;
  if (ahead == null || behind == null) base = "local-only";
  else if (ahead > 0 && behind > 0) base = `diverged +${ahead}/-${behind}`;
  else if (ahead > 0) base = `ahead ${ahead}`;
  else if (behind > 0) base = `behind ${behind}`;
  else base = "synced";
  return dirty ? `${base}, dirty` : base;
}

function formatHuman(entries: CatalogEntry[], notes: string[]): string {
  const out = [...notes];
  if (entries.length === 0) {
    out.push("No repos — clone one (`ideaspaces clone`) or create a space.");
    return out.join("\n");
  }
  const groups: Array<[RepoLocation, string]> = [
    ["available", "available:"],
    ["online-only", "online-only (pullable):"],
    ["local-only", "local-only:"],
  ];
  for (const [loc, header] of groups) {
    const items = entries.filter((e) => e.location === loc);
    if (!items.length) continue;
    if (out.length) out.push("");
    out.push(header);
    for (const e of items) {
      if (loc === "online-only") out.push(`  ${e.slug} (${e.namespace})`);
      else out.push(`  ${e.slug} — ${stateLabel(e)}${e.clone ? `  ${e.clone.path}` : ""}`);
    }
  }
  return out.join("\n");
}

export const catalogCommand: CommandDef = {
  name: "catalog",
  description: "One view of your repos — local clones and remote spaces, with sync state",
  usage: "ideaspaces catalog [--fetch] [--json]",
  examples: [
    "ideaspaces catalog",
    "ideaspaces catalog --json",
    "ideaspaces catalog --fetch  # refresh remotes first, so ahead/behind reflect the server",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    let me: AuthMeResponse | null = null;
    const notes: string[] = [];
    if (config) {
      try {
        me = await fetchAuthMe(config);
      } catch (err) {
        notes.push(
          err instanceof UnauthorizedError
            ? "Session expired — showing local clones only. Run `ideaspaces login`."
            : `Could not reach the server (${err instanceof Error ? err.message : String(err)}) — showing local clones only.`,
        );
      }
    } else {
      notes.push("Not logged in — showing local clones only. `ideaspaces login` adds the remote tier.");
    }

    const clones: CloneEntry[] = Object.entries(loadSpaces()).map(([path, record]) => ({ path, record }));

    // --fetch is opt-in and sequential (git fetch is synchronous); it refreshes
    // remote-tracking refs so ahead/behind reflect the server, not last contact.
    if (flags.fetch) {
      for (const c of clones) {
        try {
          gitFetch(c.path);
        } catch {
          // Best-effort: a clone we can't fetch keeps its last-known state.
        }
      }
    }

    const statusByPath = new Map<string, RepoStatus>();
    await Promise.all(
      clones.map(async (c) => {
        try {
          const gs = await gitState(c.path);
          statusByPath.set(c.path, { branch: gs.branch, ahead: gs.ahead, behind: gs.behind, dirty: gs.dirty });
        } catch {
          statusByPath.set(c.path, { failed: true });
        }
      }),
    );

    const entries = deriveCatalog(me, clones, statusByPath);
    output.result(
      { logged_in: me !== null, username: me?.username ?? null, notes, entries },
      formatHuman(entries, notes),
    );
    return 0;
  },
};
