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
    const clientAny = client as unknown as {
      syncStatus: (repoId?: string) => Promise<{ data: SyncStatusResult }>;
      syncPullRepo: (repoId?: string) => Promise<{ data: SyncPullResult }>;
      syncPushRepo: (repoId?: string) => Promise<{ data: SyncPushResult }>;
      setRepoCredential: (
        credential: string | null,
        repoId?: string,
      ) => Promise<{ data: RepoCredentialResult }>;
    };

    switch (op) {
      case "status": {
        const { data } = await clientAny.syncStatus(client.repoId);
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
        const { data } = await clientAny.syncPullRepo(client.repoId);
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
        const { data } = await clientAny.syncPushRepo(client.repoId);
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

        if (sub === "set") {
          const value = flags.value as string | undefined;
          if (!value) {
            output.error("Usage: ideaspaces power repo credential set --value <token>");
            return 1;
          }
          const { data } = await clientAny.setRepoCredential(value, client.repoId);
          output.result(data, `Repo credentials set for ${data.repo_id}.`);
          return 0;
        }

        if (sub === "clear") {
          const { data } = await clientAny.setRepoCredential(null, client.repoId);
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
