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
} from "../git.js";
import { loadConfig } from "../auth/credentials.js";
import { findSpaceFor } from "../auth/spaces.js";
import { fetchTrailLog, fetchTrailChanges, UnauthorizedError, type TrailCommit, type TrailChange } from "../auth/api.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const DEFAULT_LIMIT = 20;

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
  description: "Report where you and the Space stand — reads only, integrates nothing",
  usage: "ideaspaces sync [--limit <n>]",
  examples: ["ideaspaces sync", "ideaspaces sync --limit 5"],
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

    // Separate from the fetch below on purpose: this writes the global git
    // config, and folding its failure into the fetch's would report an
    // unwritable ~/.gitconfig as a network problem and send someone debugging
    // the wrong thing.
    // Guarded where `pull`/`push` call it bare, and deliberately: today it
    // swallows its own failures and cannot reject, so this is belt-and-braces
    // for the one command whose contract is that it always answers. It is the
    // only verb here a caller with no repo membership reaches — a fork, or
    // someone who was shared with — and the one where a hard failure would
    // strand a reader who has no other way to look.
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

    if (!rs.upstream) {
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
          outgoing: null,
          integrated: false,
        },
        [...lines, "No upstream configured — this ideaspace is local only.", "Publish it with: ideaspaces publish"].join("\n"),
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

    if (rs.behind) {
      const config = loadConfig();
      const record = findSpaceFor(root);
      const rootNodeId = record?.root_node_id ?? null;
      if (!config) {
        incomingNote = "Log in to see what changed on the other side: ideaspaces login";
      } else if (!rootNodeId) {
        incomingNote =
          "This clone isn't bound to a Space record, so its trail can't be addressed. Repair with: ideaspaces link";
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

        if (log.status === "fulfilled" || changes.status === "fulfilled") {
          incoming = {
            commits: log.status === "fulfilled" ? (log.value.entries ?? []) : [],
            changes: changes.status === "fulfilled" ? (changes.value.changes ?? []) : [],
          };
          const reasons = [log, changes]
            .filter((r) => r.status === "rejected")
            .map((r) => {
              const reason = (r as PromiseRejectedResult).reason;
              return reason instanceof Error ? reason.message : String(reason);
            });
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
            (r) => r.status === "rejected" && r.reason instanceof UnauthorizedError,
          );
          const err = log.reason;
          incomingNote = expired
            ? "Session expired — run `ideaspaces login` to read the Space's trail."
            : `Could not read the Space's trail: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      lines.push("", `Theirs, not here yet (behind ${rs.behind}):`);
      if (incoming) {
        for (const c of incoming.commits.slice(0, limit)) lines.push(describeTrailCommit(c));
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

    output.result(
      {
        upstream: rs.upstream,
        ahead: rs.ahead,
        behind: rs.behind,
        fetched,
        outgoing: rs.ahead
          ? { commits: outgoingCommits, paths: outgoingPaths }
          : null,
        incoming: incoming ? { commits: incoming.commits, changes: incoming.changes } : null,
        // Set on a partial read too, not only a total one — a caller that sees
        // an empty change list needs to know whether that means "nothing
        // changed" or "we could not find out".
        incoming_unavailable: incomingNote,
        // Stated in the payload, not only in the prose: nothing moved.
        integrated: false,
      },
      lines.join("\n"),
    );
    return 0;
  },
};
