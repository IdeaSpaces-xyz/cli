/**
 * `ideaspaces catalog` — one consolidated view of the account's repos, joining
 * the server list (`/auth/me`), the local clone registry (`spaces.json`), and
 * per-clone git state into a single tagged catalog.
 *
 * Auth-optional: logged out it emits the local clones only; logged in it adds
 * the remote/pullable tier. Structured data, not presentation — consumers (the
 * desktop rail, the local agent's awareness) format the state vocabulary
 * themselves; the `--json` output carries publication state and raw
 * `ahead`/`behind`/`dirty` facts.
 */

import { gitState } from "@ideaspaces/protocol";
import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import type { AuthMeRepo, AuthMeResponse } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { isHostedSpaceRecord, isUnpublishedForkRecord, listClones } from "../auth/spaces.js";
import type { SpaceRecord } from "../auth/spaces.js";
import { fetch as gitFetch } from "../git.js";
import { createOutput } from "../output.js";
import { repoRouteNamespace } from "../space-locator.js";
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
  state: "hosted" | "unpublished_fork";
  repo_id: string | null;
  root_node_id: string | null;
  slug: string | null;
  display_name: string;
  hostname: string | null;
  namespace: string;
  source_root_node_id?: string;
  source_head?: string;
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
 * which drops the remote tier: hosted clones are reported as `available`
 * because orphan status cannot be known, while an explicit unpublished fork
 * remains `local-only` by construction.
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

  const localEntry = (clone: CloneEntry, location: RepoLocation): CatalogEntry => {
    const { record, path } = clone;
    if (isUnpublishedForkRecord(record)) {
      return {
        state: "unpublished_fork",
        repo_id: null,
        root_node_id: record.root_node_id,
        slug: null,
        display_name: record.name,
        hostname: null,
        namespace: "",
        source_root_node_id: record.source_root_node_id,
        source_head: record.source_head,
        location: "local-only",
        clone: { path },
        ...syncOf(path),
      };
    }
    return {
      state: "hosted",
      repo_id: record.repo_id,
      root_node_id: record.root_node_id ?? null,
      slug: record.slug,
      display_name: record.slug,
      hostname: null,
      namespace: record.namespace,
      location,
      clone: { path },
      ...syncOf(path),
    };
  };

  if (!me) return clones.map((clone) => localEntry(clone, "available"));

  const clonesByRepo = new Map<string, CloneEntry[]>();
  for (const clone of clones) {
    if (!isHostedSpaceRecord(clone.record)) continue;
    const list = clonesByRepo.get(clone.record.repo_id) ?? [];
    list.push(clone);
    clonesByRepo.set(clone.record.repo_id, list);
  }

  const entries: CatalogEntry[] = [];
  const used = new Set<string>();
  for (const repo of me.repos) {
    const namespace = repoRouteNamespace(repo, me.username) ?? "";
    const matching = clonesByRepo.get(repo.repo_id) ?? [];
    if (matching.length === 0) {
      entries.push({
        state: "hosted",
        repo_id: repo.repo_id,
        root_node_id: repo.root_node_id ?? null,
        slug: repo.slug,
        display_name: repo.slug,
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
        state: "hosted",
        repo_id: repo.repo_id,
        root_node_id: repo.root_node_id ?? null,
        slug: repo.slug,
        display_name: repo.slug,
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
  for (const clone of clones) {
    if (used.has(clone.path)) continue;
    entries.push(localEntry(clone, "local-only"));
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
    for (const entry of items) {
      if (entry.state === "unpublished_fork") {
        out.push(`  ${entry.display_name} — unpublished local fork${entry.clone ? `  ${entry.clone.path}` : ""}`);
      } else if (loc === "online-only") {
        out.push(`  ${entry.display_name} (${entry.namespace})`);
      } else {
        out.push(`  ${entry.display_name} — ${stateLabel(entry)}${entry.clone ? `  ${entry.clone.path}` : ""}`);
      }
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

    const clones: CloneEntry[] = listClones();

    // --fetch is opt-in and sequential (git fetch is synchronous); it refreshes
    // remote-tracking refs so ahead/behind reflect the server, not last contact.
    // One bad remote must not fail the listing, but a silent stale result would
    // lie about freshness — so surface a count when any fetch fails.
    if (flags.fetch) {
      const fetchable = clones.filter((clone) => isHostedSpaceRecord(clone.record));
      let fetchFailed = 0;
      for (const clone of fetchable) {
        try {
          gitFetch(clone.path);
        } catch {
          fetchFailed++;
        }
      }
      if (fetchFailed > 0) {
        notes.push(
          `${fetchFailed} of ${fetchable.length} hosted clone(s) could not be fetched — their ahead/behind may be stale.`,
        );
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
