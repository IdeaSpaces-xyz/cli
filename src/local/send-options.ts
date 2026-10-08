import type { KeeperStreamEvent, KeeperMessageStartEvent } from "@ideaspaces/sdk";
import type { ThreadReadReceipt } from "./thread-launch.js";

export type { ThreadReadReceipt };

/** One CLI-local disclosure shape for both runtime translators. Required reach fields catch drift. */
type LocalLaunchReach = Required<Pick<KeeperMessageStartEvent,
  "cwd" | "added_dirs" | "permission_mode" | "allowed_tools" | "runtime" | "model"
>> & Pick<KeeperMessageStartEvent, "extensions" | "trust" | "allowed_tools_semantics" | "shell_available"> & {
  thread?: ThreadReadReceipt;
};

export function discloseLaunch(event: Extract<KeeperStreamEvent, { type: "message_start" }>, reach: LocalLaunchReach): KeeperMessageStartEvent & { thread?: ThreadReadReceipt } {
  return { ...event, ...reach };
}

export interface LocalSendOptions {
  onEvent?: (event: KeeperStreamEvent) => KeeperStreamEvent;
  extraOrientation?: string;
  threadReceipt?: ThreadReadReceipt;
  /** Agent-run only: vetted canonical Pi paths. Empty is intentional; never fall back to ambient. */
  extensionPaths?: string[];
  skillPaths?: string[];
  /** Additional directories granted tool access (--add-dir / reach). */
  addedDirs?: string[];
  /** Allowed tools override. */
  allowedTools?: string[];
  /** Agent-run only: headless approval requests have no human listener. */
  agentRun?: boolean;
  /** Agent-run only: recheck the transcript before invoking the child. */
  resumeOnly?: boolean;
}

export function resolveAddedDirs(opts: { repoPath: string; workingRoot?: string; addedDirs?: string[] }): string[] {
  return [...new Set([opts.workingRoot, ...(opts.addedDirs ?? [])].filter((dir): dir is string => Boolean(dir) && dir !== opts.repoPath))];
}

export function joinLocalOrientation(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join("\n\n") || undefined;
}
