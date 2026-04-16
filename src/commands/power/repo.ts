import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import { setLastSha } from "../../auth/session-state.js";
import type { CommandDef } from "../../types.js";

interface SyncStatusResult {
  repo_id: string;
  status: "fresh" | "stale" | "unindexed" | "empty";
  is_fresh: boolean;
  repo_head: string | null;
  indexed_head: string | null;
  last_indexed_at: string | null;
  lag_commits: number | null;
  last_index_error: string | null;
}

interface SyncPullResult {
  repo_id: string;
  diverged: boolean;
  old_head: string | null;
  new_head: string | null;
  indexed_files: number;
  removed_entries: number;
  changed_markdown_files: string[];
  status: "ok" | "diverged";
}

interface SyncPushResult {
  repo_id: string;
  rejected: boolean;
  reason: string | null;
  head: string | null;
  status: "ok" | "rejected";
}

interface RepoCredentialResult {
  repo_id: string;
  has_credentials: boolean;
}

export const repoCommand: CommandDef = {
  name: "repo",
  description: "Repo sync operations: status, pull, push, credentials",
  usage: "ideaspaces power repo <status|pull|push|credential set|credential clear> [--value TOKEN]",
  examples: [
    "ideaspaces power repo status",
    "ideaspaces power repo pull",
    "ideaspaces power repo push",
    "ideaspaces power repo credential set --value ghp_xxx",
    "ideaspaces power repo credential clear",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const op = args[0];
    if (!op) {
      output.error("Usage: ideaspaces power repo <status|pull|push|credential>");
      return 1;
    }

    const client = await initClient(global);
    const clientAny = client as any;
    const rawReq = typeof clientAny.req === "function"
      ? ((method: string, path: string, body?: unknown) =>
          clientAny.req(method, path, body) as Promise<{ data: unknown }>)
      : undefined;

    switch (op) {
      case "status": {
        const syncStatus = clientAny.syncStatus as
          | ((repoId?: string) => Promise<{ data: SyncStatusResult }>)
          | undefined;

        const response = typeof syncStatus === "function"
          ? await syncStatus(client.repoId)
          : typeof rawReq === "function"
            ? await rawReq("GET", `/repos/${client.repoId}/sync/status`)
            : null;

        if (!response) {
          output.error("SDK in this CLI build cannot call sync status. Update @ideaspaces/sdk.");
          return 1;
        }

        const data = response.data as SyncStatusResult;
        const lines = [
          `Repo: ${data.repo_id}`,
          `Status: ${data.status}${data.is_fresh ? " (fresh)" : ""}`,
          `Repo HEAD: ${data.repo_head || "(empty)"}`,
          `Indexed HEAD: ${data.indexed_head || "(none)"}`,
          data.lag_commits != null ? `Lag commits: ${data.lag_commits}` : "",
          data.last_indexed_at ? `Last indexed: ${data.last_indexed_at}` : "",
          data.last_index_error ? `Last index error: ${data.last_index_error}` : "",
        ].filter(Boolean);

        output.result(data, lines.join("\n"));
        return 0;
      }

      case "pull": {
        const syncPullRepo = clientAny.syncPullRepo as
          | ((repoId?: string) => Promise<{ data: SyncPullResult }>)
          | undefined;

        const response = typeof syncPullRepo === "function"
          ? await syncPullRepo(client.repoId)
          : typeof rawReq === "function"
            ? await rawReq("POST", `/repos/${client.repoId}/sync/pull`)
            : null;

        if (!response) {
          output.error("SDK in this CLI build cannot call sync pull. Update @ideaspaces/sdk.");
          return 1;
        }

        const data = response.data as SyncPullResult;
        if (data.new_head) {
          try { setLastSha(client.repoId, data.new_head); } catch { /* best effort */ }
        }

        const lines = [
          `Repo: ${data.repo_id}`,
          data.diverged
            ? "Pull status: diverged (fast-forward only pull rejected)"
            : "Pull status: ok",
          `Old HEAD: ${data.old_head || "(empty)"}`,
          `New HEAD: ${data.new_head || "(empty)"}`,
          `Indexed files: ${data.indexed_files}`,
          `Removed entries: ${data.removed_entries}`,
          data.changed_markdown_files.length
            ? `Changed markdown files: ${data.changed_markdown_files.length}`
            : "Changed markdown files: 0",
        ];

        output.result(data, lines.join("\n"));
        return 0;
      }

      case "push": {
        const syncPushRepo = clientAny.syncPushRepo as
          | ((repoId?: string) => Promise<{ data: SyncPushResult }>)
          | undefined;

        const response = typeof syncPushRepo === "function"
          ? await syncPushRepo(client.repoId)
          : typeof rawReq === "function"
            ? await rawReq("POST", `/repos/${client.repoId}/sync/push`)
            : null;

        if (!response) {
          output.error("SDK in this CLI build cannot call sync push. Update @ideaspaces/sdk.");
          return 1;
        }

        const data = response.data as SyncPushResult;
        if (data.head) {
          try { setLastSha(client.repoId, data.head); } catch { /* best effort */ }
        }

        const lines = [
          `Repo: ${data.repo_id}`,
          data.rejected ? `Push rejected${data.reason ? ` (${data.reason})` : ""}` : "Push status: ok",
          `HEAD: ${data.head || "(empty)"}`,
        ];

        output.result(data, lines.join("\n"));
        return data.rejected ? 5 : 0;
      }

      case "credential": {
        const sub = args[1];
        const setRepoCredential = clientAny.setRepoCredential as
          | ((gitCredential: string | null, repoId?: string) => Promise<{ data: RepoCredentialResult }>)
          | undefined;

        if (sub === "set") {
          const value = flags.value as string | undefined;
          if (!value) {
            output.error("Usage: ideaspaces power repo credential set --value <token>");
            return 1;
          }

          const response = typeof setRepoCredential === "function"
            ? await setRepoCredential(value, client.repoId)
            : typeof rawReq === "function"
              ? await rawReq("POST", `/repos/${client.repoId}/credentials`, { git_credential: value })
              : null;

          if (!response) {
            output.error("SDK in this CLI build cannot set repo credentials. Update @ideaspaces/sdk.");
            return 1;
          }

          const data = response.data as RepoCredentialResult;
          output.result(data, `Repo credentials set for ${data.repo_id}.`);
          return 0;
        }

        if (sub === "clear") {
          const response = typeof setRepoCredential === "function"
            ? await setRepoCredential(null, client.repoId)
            : typeof rawReq === "function"
              ? await rawReq("POST", `/repos/${client.repoId}/credentials`, { git_credential: null })
              : null;

          if (!response) {
            output.error("SDK in this CLI build cannot clear repo credentials. Update @ideaspaces/sdk.");
            return 1;
          }

          const data = response.data as RepoCredentialResult;
          output.result(data, `Repo credentials cleared for ${data.repo_id}.`);
          return 0;
        }

        output.error("Usage: ideaspaces power repo credential <set|clear> [--value TOKEN]");
        return 1;
      }

      default:
        output.error("Usage: ideaspaces power repo <status|pull|push|credential>");
        return 1;
    }
  },
};
