import type { KeeperStreamEvent } from "@ideaspaces/sdk";

export interface LocalSendOptions {
  onEvent?: (event: KeeperStreamEvent) => KeeperStreamEvent;
  extraOrientation?: string;
  /** Agent-run only: do not inherit executable paths from the parent environment. */
  explicitLaunch?: boolean;
  /** Agent-run only: recheck the transcript before invoking the child. */
  resumeOnly?: boolean;
}

export function joinLocalOrientation(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join("\n\n") || undefined;
}
