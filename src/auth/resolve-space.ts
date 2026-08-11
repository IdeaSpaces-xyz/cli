/**
 * Which Space is this clone?
 *
 * The registry answers instantly when it can, but it is not the only place the
 * answer lives, and for a long time it did not hold it at all: records written
 * before canonical root locators carry `repo_id`, `slug`, and `namespace` and
 * no `root_node_id`. On a machine with eighteen such records, every hosted read
 * addressed by root node id is unreachable — not refused, unaddressable.
 *
 * So resolve rather than require, in the order that costs least:
 *
 *   1. the registry record — free
 *   2. the clone's own origin — free, when it is `/spaces/{root}.git`
 *   3. the account's repo list — one call, matched on the origin
 *
 * Rungs 2 and 3 serve different people, which is why both exist. A Grant-only
 * reader — the fork holder or the person a Space was shared with, exactly who
 * hosted history is for — never appears in `auth/me`, because that list is
 * membership-shaped. But their clone's origin *is* canonical, because that is
 * what `fork` and `clone` write. Rung 2 covers precisely who rung 3 cannot.
 *
 * A resolution below the top rung heals the record on the way past, so the cost
 * is paid once per clone rather than once per command. Healing is best-effort:
 * knowing the answer matters more than storing it.
 */

import { fetchAuthMe, deriveGitBase, type ApiConfig } from "./api.js";
import { getDefaultApiUrl } from "./credentials.js";
import { findSpaceFor, saveSpace, type SpaceRecord } from "./spaces.js";
import { normalizeRepoUrl, originUrl } from "../git.js";
import { repoKeys, rootNodeIdFromGitUrl, spaceRecordForRepo } from "../space-locator.js";

export interface SpaceBinding {
  rootNodeId: string;
  /** Which rung answered. Surfaced in `--json` so a reader can see how a
   * clone was identified — a registry hit and an account lookup are very
   * different answers when something looks wrong. */
  via: "record" | "origin" | "account";
}

/**
 * Why resolution failed, when it does.
 *
 * The three are not interchangeable advice. Telling someone to run `link`
 * because their account could not be reached is wrong — `link` makes the same
 * call and fails the same way.
 */
export type BindingFailure = "no-match" | "ambiguous" | "unreachable";

/** Merge a resolved root node id into whatever the registry already held. */
function healed(existing: SpaceRecord, rootNodeId: string): SpaceRecord {
  return { ...existing, root_node_id: rootNodeId };
}

/**
 * Resolve the Space a clone belongs to, healing the registry when it can.
 *
 * Returns null only when every rung is exhausted: no record, a non-canonical
 * origin, and either no session or no matching Space on the account.
 */
export async function resolveSpaceBinding(
  dir: string,
  config: ApiConfig | null,
): Promise<SpaceBinding | { failure: BindingFailure }> {
  const record = findSpaceFor(dir);
  if (record?.root_node_id) return { rootNodeId: record.root_node_id, via: "record" };

  const origin = originUrl(dir);

  // Rung 2 — the coordinate is in the remote. No account needed, which is the
  // point: this is the rung a Grant-only reader arrives on.
  if (origin) {
    // The host check must not depend on being logged in. `sync` with no
    // session is the *normal* first call for a Grant-only reader, and a
    // resolution that skipped the check would be healed into the registry and
    // then trusted forever by rung 1, which never re-validates.
    const fromOrigin = rootNodeIdFromGitUrl(origin, config?.apiUrl ?? getDefaultApiUrl());
    if (fromOrigin) {
      // Only ever augment a record that exists. A brand-new one written here
      // would carry empty repo_id/slug/namespace — `SpaceRecord` treats those
      // as populated everywhere else, and `publish`'s stale-mapping check
      // reads them straight off the registry and would report a folder mapped
      // to "/" with no repo. Rung 2 costs nothing to repeat, so re-resolving
      // is cheaper than a half-written record other commands must survive.
      if (record) {
        try {
          saveSpace(dir, healed(record, fromOrigin));
        } catch {
          // A registry we cannot write is not a reason to withhold the answer.
        }
      }
      return { rootNodeId: fromOrigin, via: "origin" };
    }
  }

  // Rung 3 — a legacy origin. Ask the account which Space it is.
  if (!config || !origin) return { failure: "no-match" };
  const originKey = normalizeRepoUrl(origin);
  if (!originKey) return { failure: "no-match" };

  let me;
  try {
    me = await fetchAuthMe(config);
  } catch {
    return { failure: "unreachable" };
  }

  const gitBase = deriveGitBase(config.apiUrl);
  const matches = me.repos.filter((repo) =>
    repoKeys(repo, me, gitBase, config.apiUrl).includes(originKey),
  );
  // Ambiguity is not ours to break — `link <dir> <space>` exists to be told.
  if (matches.length > 1) return { failure: "ambiguous" };
  if (matches.length === 0) return { failure: "no-match" };

  const repo = matches[0];
  if (!repo.root_node_id) return { failure: "no-match" };

  try {
    // Merge, never replace. `spaceRecordForRepo` builds from what the server
    // knows, and the server does not know a fork's lineage:
    // `source_root_node_id` / `source_head` are written by `fork` alone and
    // reconstructible from nothing. A record from an older `fork` carries them
    // *and* no root_node_id — precisely the population this resolver exists to
    // heal — so replacing it here would destroy the lineage while fixing the
    // binding, silently, inside a command that otherwise writes nothing.
    saveSpace(dir, { ...(record ?? {}), ...spaceRecordForRepo(repo, me.username) });
  } catch {
    // Same as above: answer now, store if we can.
  }
  return { rootNodeId: repo.root_node_id, via: "account" };
}
