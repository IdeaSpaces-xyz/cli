/**
 * `ideaspaces sync` — see where you and the Space stand. Integrates nothing.
 *
 * The word came back because the question did. `sync` was removed when it was
 * split into `pull` and `push`, on the grounds that a single verb hid the
 * direction. But the thing people reach for `sync` to ask is not "integrate my
 * work" — it is *"what happened while I was away?"*. That question has no
 * direction and no side effect, and until now nothing answered it.
 *
 *   local position  →  git remote-tracking state (ahead / behind)
 *   what changed    →  the Space's trail, read by root node id
 *   fork source     →  the source trail since the locally recorded fork pin
 *
 * Source awareness is independent of maintained updates: it requires explicit
 * hosted-history authority and reads raw commits and paths; `update` requires
 * copy authority and reads the transformed current-content projection.
 *
 * **It never integrates.** No merge, no rebase, no push, no checkout, nothing
 * written to the working tree or to the Space. `git status` is byte-identical
 * afterwards. Two things it does touch, both outside that boundary: `git fetch`
 * moves remote-tracking refs and no files — the same thing `status --fetch`
 * already does, and the only way to know your position without asking the
 * network to guess — and `registerGitCredentialHelper` writes the global git
 * config, as it does for `pull`, `push`, and `clone`.
 *
 * Reading the remote trail needs the Space registered (`spaces.json` supplies
 * the root node id) and a login. Without either, the local half still reports
 * and the command says which half is missing rather than failing.
 */

import {
  repoRoot,
  fetch as gitFetch,
  remoteState,
  mergeBaseWithUpstream,
  commitsAheadOfUpstream,
  pathsAheadOfUpstream,
  commitsNotInHistory,
} from "../git.js";
import { loadConfig } from "../auth/credentials.js";
import { resolveSpaceBinding } from "../auth/resolve-space.js";
import {
  findSpaceFor,
  isUnpublishedForkRecord,
  type SpaceRecord,
} from "../auth/spaces.js";
import {
  fetchTrailLog,
  fetchTrailChanges,
  describeTrailRefusal,
  UnauthorizedError,
  type ApiConfig,
  type TrailCommit,
  type TrailChange,
} from "../auth/api.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const DEFAULT_LIMIT = 20;
// Independent of --limit: finding the recorded pin needs the widest bounded
// server window even when the person asks to print only a few entries.
const SOURCE_COMMIT_LIMIT = 100;

interface SourceAwareness {
  root_node_id: string;
  recorded_head: string | null;
  current_head: string | null;
  moved: boolean | null;
  commits: TrailCommit[] | null;
  commits_complete: boolean;
  changes: TrailChange[] | null;
  unavailable: string | null;
}

function sameCommit(left: string, right: string): boolean {
  // The hosted log emits git's abbreviated `%h`, while fork lineage records a
  // full SHA. Both sides are validated before this comparison; seven hex chars
  // is the shortest server value we accept.
  const [shorter, longer] = [left.toLowerCase(), right.toLowerCase()].sort(
    (a, b) => a.length - b.length,
  );
  return longer.startsWith(shorter);
}

function isTrailCommit(value: unknown): value is TrailCommit {
  if (!value || typeof value !== "object") return false;
  const commit = value as Partial<TrailCommit>;
  return (
    typeof commit.sha === "string" &&
    /^[0-9a-f]{7,40}$/i.test(commit.sha) &&
    typeof commit.message === "string" &&
    typeof commit.date === "string" &&
    typeof commit.author === "string"
  );
}

function isTrailChange(value: unknown): value is TrailChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<TrailChange>;
  return (
    typeof change.status === "string" &&
    typeof change.path === "string" &&
    (change.old_path === undefined || typeof change.old_path === "string")
  );
}

function describeSourceFailure(err: unknown): string {
  if (err instanceof UnauthorizedError) {
    return "Session expired — run `ideaspaces login` to read the source Space's trail.";
  }
  const refusal = describeTrailRefusal(err, "source");
  if (refusal) return refusal;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("→ 422")) {
    return "The recorded source point is no longer available in the source trail; the source may have been rewritten.";
  }
  return `Could not read the source Space's trail: ${message}`;
}

async function readSourceAwareness(
  config: ApiConfig,
  rootNodeId: string,
  recordedHead: string,
): Promise<SourceAwareness> {
  const base = {
    root_node_id: rootNodeId,
    recorded_head: recordedHead,
  };
  if (!/^[0-9a-f]{40}$/i.test(recordedHead)) {
    return {
      ...base,
      current_head: null,
      moved: null,
      commits: null,
      commits_complete: false,
      changes: null,
      unavailable: "This fork's recorded source head is invalid, so source movement cannot be checked.",
    };
  }

  const [log, changes] = await Promise.allSettled([
    fetchTrailLog(config, rootNodeId, SOURCE_COMMIT_LIMIT),
    fetchTrailChanges(config, rootNodeId, recordedHead),
  ]);
  const rawEntries: unknown = log.status === "fulfilled" ? log.value.entries : null;
  const rawChanges: unknown = changes.status === "fulfilled" ? changes.value.changes : null;
  const entries = Array.isArray(rawEntries) && rawEntries.every(isTrailCommit) ? rawEntries : null;
  const changedPaths = Array.isArray(rawChanges) && rawChanges.every(isTrailChange) ? rawChanges : null;
  const pinIndex = entries?.findIndex((entry) => sameCommit(entry.sha, recordedHead)) ?? -1;
  const currentHead = entries?.[0]?.sha ?? null;
  const moved = currentHead
    ? !sameCommit(currentHead, recordedHead)
    : changedPaths?.length
      ? true
      // An empty diff does not prove the source stayed put: it may have gained
      // empty commits. An empty log is not proof either — the recorded pin says
      // this source had a commit when forked. Only a non-empty valid log can
      // establish `false`.
      : null;
  const validationFailures = [
    ...(log.status === "fulfilled" && entries === null
      ? ["The source Space returned an invalid commit list."]
      : []),
    ...(changes.status === "fulfilled" && changedPaths === null
      ? ["The source Space returned an invalid changed-path list."]
      : []),
  ];
  const failures = [...new Set([
    ...validationFailures,
    ...[log, changes]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => describeSourceFailure(result.reason)),
  ])];

  return {
    ...base,
    current_head: currentHead,
    moved,
    commits: entries ? (pinIndex >= 0 ? entries.slice(0, pinIndex) : entries) : null,
    commits_complete: entries !== null && pinIndex >= 0,
    changes: changedPaths,
    unavailable: failures.length ? failures.join("; ") : null,
  };
}

function sourceAwarenessFor(
  record: SpaceRecord | null,
  config: ApiConfig | null,
): Promise<SourceAwareness | null> {
  if (!record?.source_root_node_id) return Promise.resolve(null);
  if (!record.source_head) {
    return Promise.resolve({
      root_node_id: record.source_root_node_id,
      recorded_head: null,
      current_head: null,
      moved: null,
      commits: null,
      commits_complete: false,
      changes: null,
      unavailable: "This fork has a recorded source but no pinned source head, so source movement cannot be checked.",
    });
  }
  if (!config) {
    return Promise.resolve({
      root_node_id: record.source_root_node_id,
      recorded_head: record.source_head,
      current_head: null,
      moved: null,
      commits: null,
      commits_complete: false,
      changes: null,
      unavailable: "Log in to read the source Space's trail: ideaspaces login",
    });
  }
  return readSourceAwareness(config, record.source_root_node_id, record.source_head);
}

function appendSourceAwareness(lines: string[], source: SourceAwareness, limit: number): void {
  lines.push("", "Fork source:");
  if (source.moved === false) {
    lines.push(`  has not moved since ${source.recorded_head?.slice(0, 12)}`);
  } else if (source.moved === true) {
    lines.push(`  moved since ${source.recorded_head?.slice(0, 12)}:`);
  }

  for (const commit of source.commits?.slice(0, limit) ?? []) lines.push(describeTrailCommit(commit));
  if (source.commits && source.commits.length > limit) {
    lines.push(`  … and ${source.commits.length - limit} more (--limit ${Math.min(100, source.commits.length)} to see more, --json for all)`);
  }
  if (source.commits && !source.commits_complete) {
    lines.push(`  (the recorded point is not in the source's latest ${SOURCE_COMMIT_LIMIT} commits; it may be older or no longer in history — showing that recent window)`);
  }
  if (source.changes?.length) {
    lines.push("", "Source paths changed:");
    for (const change of source.changes.slice(0, limit)) lines.push(describeChange(change));
    if (source.changes.length > limit) {
      lines.push(`  … and ${source.changes.length - limit} more (--limit ${Math.min(100, source.changes.length)} to see more, --json for all)`);
    }
  }
  if (source.unavailable) {
    const prefix = source.commits !== null || source.changes !== null ? "Partial: " : "";
    lines.push(`  ${prefix}${source.unavailable}`);
  }
  if (source.moved === null && !source.unavailable) {
    lines.push("  Source movement could not be determined.");
  }
  lines.push("  Awareness only — no fork files were changed.");
}

function limitFlag(value: string | boolean | undefined): number {
  if (typeof value !== "string") return DEFAULT_LIMIT;
  const n = Number.parseInt(value, 10);
  // The endpoint caps at 100 and refuses 0 — clamp rather than round-trip a 422.
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(100, Math.max(1, n));
}

function describeChange(change: TrailChange): string {
  const verb =
    change.status.startsWith("A") ? "added" :
    change.status.startsWith("D") ? "deleted" :
    change.status.startsWith("R") ? "renamed" :
    change.status.startsWith("C") ? "copied" :
    "changed";
  return change.old_path ? `  ${verb}  ${change.old_path} → ${change.path}` : `  ${verb}  ${change.path}`;
}

function describeCommit(sha: string, subject: string): string {
  return `  ${sha.slice(0, 8)}  ${subject}`;
}

function describeTrailCommit(commit: TrailCommit): string {
  return describeCommit(commit.sha, commit.message.split("\n")[0]);
}

export const syncCommand: CommandDef = {
  name: "sync",
  description: "Report where you, the Space, and a fork's source stand — reads only, integrates nothing",
  usage: "ideaspaces sync [--limit <n>]",
  examples: [
    "ideaspaces sync",
    "ideaspaces sync --limit 5 # print 5 entries; source lookup still checks its bounded 100-commit window",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const limit = limitFlag(flags.limit as string | boolean | undefined);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const config = loadConfig();
    const record = findSpaceFor(root);
    const initialRemoteState = remoteState(root);
    // An unpublished fork intentionally has no destination remote. Do not run
    // credential-helper or fetch effects and then report their expected failure
    // as a network problem. Its source coordinate is still useful awareness.
    if (record && isUnpublishedForkRecord(record)) {
      const source = await sourceAwarenessFor(record, config);
      const lines = [
        "Unpublished local fork — no destination upstream exists yet.",
        `Local identity: ${record.root_node_id}`,
        `Source: ${record.source_root_node_id} at ${record.source_head.slice(0, 12)}`,
        "Publish it with: ideaspaces publish",
      ];
      if (initialRemoteState.upstream) {
        lines.push(
          `Registry drift: git reports upstream ${initialRemoteState.upstream}; publication state was not inferred from it.`,
        );
      }
      if (source) appendSourceAwareness(lines, source, limit);
      output.result(
        {
          publication_state: "unpublished_fork",
          root_node_id: record.root_node_id,
          upstream: null,
          ahead: 0,
          behind: 0,
          fetched: false,
          incoming: null,
          incoming_unavailable: null,
          resolved_via: null,
          outgoing: null,
          source,
          integrated: false,
        },
        lines.join("\n"),
      );
      return 0;
    }

    // Separate from the fetch below, and guarded where `pull`/`push` call it
    // bare — both for the same reason. It writes the global git config, so
    // folding it into the fetch's catch would report an unwritable
    // ~/.gitconfig as a network problem.
    try {
      await registerGitCredentialHelper();
    } catch {
      // The fetch below reports for real if auth is the actual problem.
    }

    // Refs only. Failure is not fatal — a stale position beats no answer, and
    // saying the position is stale is more use than exiting 1.
    let fetched = true;
    let fetchError: string | null = null;
    try {
      gitFetch(root);
    } catch (err) {
      fetched = false;
      fetchError = err instanceof Error ? err.message : String(err);
    }

    const rs = remoteState(root);
    const lines: string[] = [];
    if (!fetched) {
      lines.push(`Could not reach the remote (${fetchError}) — position below is from the last fetch.`);
    }

    // Start source awareness now, but do not serialize the fork-copy's incoming
    // trail behind it. A behind fork can ask both independent reads at once.
    const sourcePromise = sourceAwarenessFor(record, config);

    if (!rs.upstream) {
      const source = await sourcePromise;
      // Not an error: a local-only space is a legitimate state, and `sync`
      // answering "you have no other side" is a real answer.
      output.result(
        {
          upstream: null,
          ahead: 0,
          behind: 0,
          fetched,
          incoming: null,
          // Present and null, not absent: a --json caller reads one schema
          // across every exit path, rather than one that varies by branch.
          incoming_unavailable: null,
          resolved_via: null,
          outgoing: null,
          source,
          integrated: false,
        },
        (() => {
          const localOnlyLines = [...lines, "No upstream configured — this ideaspace is local only.", "Publish it with: ideaspaces publish"];
          if (source) appendSourceAwareness(localOnlyLines, source, limit);
          return localOnlyLines.join("\n");
        })(),
      );
      return 0;
    }

    lines.push(`${rs.upstream}: ahead ${rs.ahead}, behind ${rs.behind}`);

    // Outgoing is answerable from local refs alone — no network, no account.
    const outgoingCommits = rs.ahead ? commitsAheadOfUpstream(root) : [];
    const outgoingPaths = rs.ahead ? pathsAheadOfUpstream(root) : [];
    if (rs.ahead) {
      lines.push("", `Yours, not sent yet (${outgoingCommits.length}):`);
      for (const c of outgoingCommits.slice(0, limit)) lines.push(describeCommit(c.sha, c.subject));
      if (outgoingCommits.length > limit) lines.push(`  … and ${outgoingCommits.length - limit} more`);
      if (outgoingPaths.length) {
        lines.push(`  paths: ${outgoingPaths.slice(0, 10).join(", ")}${outgoingPaths.length > 10 ? ` … +${outgoingPaths.length - 10}` : ""}`);
      }
      lines.push("  Send them with: ideaspaces push");
    }

    // Incoming contents come from the Space's trail, not from git: the point of
    // this slice is that a fork or a person shared with can read it, and those
    // callers have no repo membership to address it by.
    let incoming: { commits: TrailCommit[]; changes: TrailChange[] } | null = null;
    let incomingNote: string | null = null;
    // Set when git could not tell incoming commits from ones we already have,
    // so the list is shown whole rather than suppressed — and said to be whole.
    let unfiltered = false;
    // Whether a window came back at all. An empty list means two different
    // things depending on this, and they need opposite advice.
    let windowRead = false;
    // How this clone was identified. A registry hit and an account lookup are
    // very different answers when a reader is working out why something looks
    // wrong, so it is reported rather than kept internal.
    let resolvedVia: "record" | "origin" | "account" | null = null;

    if (rs.behind) {
      // Not "is this clone registered" but "which Space is it" — a legacy
      // record without a root node id still knows, and so does the origin.
      const binding = await resolveSpaceBinding(root, config);
      const rootNodeId = "rootNodeId" in binding ? binding.rootNodeId : null;
      resolvedVia = "via" in binding ? binding.via : null;
      if (!rootNodeId) {
        const failure = "failure" in binding ? binding.failure : "no-match";
        // Each dead end has a different next step, and one of them is not
        // `link`: when the account could not be reached, `link` makes the same
        // call and fails the same way.
        incomingNote = !config
          ? "Log in to see what changed on the other side: ideaspaces login"
          : failure === "unreachable"
            ? "Could not reach your account to work out which Space this clone is. Retry when you're back online."
            : failure === "ambiguous"
              ? "This clone's origin matches more than one of your Spaces. Name the right one: ideaspaces link . <space>"
              : "Could not tell which Space this clone belongs to — its origin isn't a canonical Space URL " +
                "and no Space on your account matches it. Bind it explicitly: ideaspaces link . <space>";
      } else if (!config) {
        // The coordinate came from the clone itself; reading the trail still
        // needs a session.
        incomingNote = "Log in to read this Space's trail: ideaspaces login";
      } else {
        const since = mergeBaseWithUpstream(root);
        // Settled independently: the commit list is worth showing even when the
        // path list fails, and vice versa. All-or-nothing would drop a good half
        // for a transient failure in the other.
        const [log, changes] = await Promise.allSettled([
          fetchTrailLog(config, rootNodeId, limit),
          since
            ? fetchTrailChanges(config, rootNodeId, since)
            : Promise.resolve({ op: "changes", since: "", changes: [] as TrailChange[] }),
        ]);

        const rawReported: unknown = log.status === "fulfilled" ? log.value.entries : null;
        const rawChangedPaths: unknown = changes.status === "fulfilled" ? changes.value.changes : null;
        const reported = Array.isArray(rawReported) && rawReported.every(isTrailCommit)
          ? rawReported
          : null;
        const incomingChanges = Array.isArray(rawChangedPaths) && rawChangedPaths.every(isTrailChange)
          ? rawChangedPaths
          : null;
        const reasons = [
          ...(log.status === "fulfilled" && reported === null
            ? ["The Space returned an invalid commit list."]
            : []),
          ...(changes.status === "fulfilled" && incomingChanges === null
            ? ["The Space returned an invalid changed-path list."]
            : []),
          ...[log, changes]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => (
              describeTrailRefusal(result.reason) ??
              (result.reason instanceof Error ? result.reason.message : String(result.reason))
            )),
        ];

        if (reported !== null || incomingChanges !== null) {
          // The endpoint answers "the Space's most recent commits" — it takes a
          // limit, not a range — so what comes back is not what is incoming.
          // Only the local repo knows which of them we already have.
          windowRead = reported !== null;
          const fresh = reported ? commitsNotInHistory(reported.map((c) => c.sha), root) : new Set<string>();
          if (fresh === null) unfiltered = true;
          incoming = {
            commits: reported
              ? (fresh ? reported.filter((c) => fresh.has(c.sha)) : reported)
              : [],
            changes: incomingChanges ?? [],
          };
          if (reasons.length) incomingNote = `Partial: ${reasons.join("; ")}`;
          // Same rule as a failed fetch: an empty change list must not be
          // readable as "nothing changed" when we never got to ask. Unrelated
          // histories have no common point to ask about.
          else if (!since) {
            incomingNote =
              "No common commit with the upstream, so the changed paths could not be asked for — the commits above are the whole answer.";
          }
        } else {
          // Either rejection can be the 401. Prefer it over the other reason:
          // "session expired" is the one message here the reader can act on,
          // and it should not depend on which call happened to fail first.
          const expired = [log, changes].some(
            (result) => result.status === "rejected" && result.reason instanceof UnauthorizedError,
          );
          // A refusal is an answer, not a fault: prefer whichever rejection can
          // explain itself over validation failures or raw fault text.
          const refusal = [log, changes]
            .map((result) => result.status === "rejected" ? describeTrailRefusal(result.reason) : null)
            .find(Boolean);
          incomingNote = expired
            ? "Session expired — run `ideaspaces login` to read the Space's trail."
            : (refusal ?? `Could not read the Space's trail: ${reasons.join("; ")}`);
        }
      }

      lines.push("", `Theirs, not here yet (behind ${rs.behind}):`);
      if (incoming) {
        if (!incoming.commits.length && !unfiltered && windowRead) {
          // Behind, and the window we did read holds only commits we have —
          // the ones we lack are older than it. Gated on actually having read
          // a window: when the log call failed there is nothing to widen, and
          // the real reason follows on the next line.
          lines.push(`  (nothing new in the Space's last ${limit} commits — raise --limit to look further back)`);
        }
        for (const c of incoming.commits.slice(0, limit)) lines.push(describeTrailCommit(c));
        if (unfiltered) {
          lines.push("  (showing the Space's recent commits — some may already be yours)");
        }
        if (incoming.changes.length) {
          lines.push("", "What changed:");
          // Bounded like every other list here. Coming back after a long
          // absence is the case this command exists for, which is exactly when
          // this list is longest — the JSON payload keeps all of it.
          for (const change of incoming.changes.slice(0, limit)) lines.push(describeChange(change));
          if (incoming.changes.length > limit) {
            lines.push(`  … and ${incoming.changes.length - limit} more (--limit ${Math.min(100, incoming.changes.length)} to see more, --json for all)`);
          }
        }
        // A half-answer must say which half is missing, or it reads as whole.
        if (incomingNote) lines.push(`  ${incomingNote}`);
        lines.push("", "Integrate them when you're ready: ideaspaces pull");
      } else {
        lines.push(`  ${incomingNote}`);
      }
    }

    if (!rs.ahead && !rs.behind) lines.push("", "Nothing on either side — you are level with the Space.");
    const source = await sourcePromise;
    if (source) appendSourceAwareness(lines, source, limit);

    output.result(
      {
        upstream: rs.upstream,
        ahead: rs.ahead,
        behind: rs.behind,
        fetched,
        outgoing: rs.ahead
          ? { commits: outgoingCommits, paths: outgoingPaths }
          : null,
        incoming: incoming
          ? {
              commits: incoming.commits,
              changes: incoming.changes,
              // False when git could not separate incoming commits from ones
              // already held: the list is the Space's recent history and may
              // include your own. A caller that pulls on a non-empty list
              // needs to know which of the two it is looking at.
              commits_filtered: !unfiltered,
            }
          : null,
        // Set on a partial read too, not only a total one — a caller that sees
        // an empty change list needs to know whether that means "nothing
        // changed" or "we could not find out".
        incoming_unavailable: incomingNote,
        resolved_via: resolvedVia,
        source,
        // Stated in the payload, not only in the prose: nothing moved.
        integrated: false,
      },
      lines.join("\n"),
    );
    return 0;
  },
};
