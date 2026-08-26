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
import {
  findSpaceFor,
  isUnpublishedForkRecord,
  saveSpace,
  withForkLineage,
  type HostedSpaceRecord,
} from "./spaces.js";
import { normalizeRepoUrl, originUrl } from "../git.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { repoKeys, spaceRecordForRepo } from "../space-locator.js";

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
export type BindingFailure =
  | "no-match"
  | "ambiguous"
  | "unreachable"
  | "unpublished"
  | "local-only"
  | "identity-invalid"
  | "identity-drift"
  | "identity-ambiguous"
  | "identity-dirty";

/** Merge a resolved root node id into whatever the registry already held. */
function healed(existing: HostedSpaceRecord, rootNodeId: string): HostedSpaceRecord {
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
  let localIdentity;
  try {
    localIdentity = inspectLocalRootIdentity(dir, config?.apiUrl);
  } catch {
    return { failure: "identity-invalid" };
  }
  if (localIdentity.declaration.dirty) return { failure: "identity-dirty" };
  if (localIdentity.state === "invalid") return { failure: "identity-invalid" };
  if (localIdentity.state === "drift") return { failure: "identity-drift" };
  if (localIdentity.state === "ambiguous") return { failure: "identity-ambiguous" };

  // A local declaration or unpublished fork owns identity but has no hosted
  // destination. Returning it as a binding would address a Keeper as though
  // publication had already happened.
  if (record && isUnpublishedForkRecord(record)) return { failure: "unpublished" };
  if (localIdentity.state === "local_only") return { failure: "local-only" };

  if (localIdentity.local_registry && localIdentity.root_node_id) {
    return { rootNodeId: localIdentity.root_node_id, via: "record" };
  }

  const origin = originUrl(dir);

  // Rung 2 — the coordinate is in the remote. No account needed, which is the
  // point: this is the rung a Grant-only reader arrives on. The shared local
  // evaluator has already checked it against declaration and registry evidence.
  if (localIdentity.canonical_origin && localIdentity.root_node_id) {
    const fromOrigin = localIdentity.root_node_id;
    // Only ever augment a hosted record that exists. A brand-new one written
    // here would carry synthetic repo/route metadata.
    if (record && !isUnpublishedForkRecord(record)) {
      try {
        saveSpace(dir, healed(record, fromOrigin));
      } catch {
        // A registry we cannot write is not a reason to withhold the answer.
      }
    }
    return { rootNodeId: fromOrigin, via: "origin" };
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
    // The server's view, carrying only what the server cannot know: a record
    // from an older `fork` holds lineage *and* no root_node_id — precisely the
    // population this resolver heals — so replacing outright would fix the
    // binding and destroy the lineage in one silent write. Spreading the whole
    // old record under it is the other trap: it would keep routing fields the
    // server has since dropped.
    saveSpace(dir, withForkLineage(spaceRecordForRepo(repo, me.username), record));
  } catch {
    // Same as above: answer now, store if we can.
  }
  return { rootNodeId: repo.root_node_id, via: "account" };
}
