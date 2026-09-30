import type { KeeperStreamEvent } from "@ideaspaces/sdk";

export interface LocalSendOptions {
  onEvent?: (event: KeeperStreamEvent) => KeeperStreamEvent;
  extraOrientation?: string;
  /** Agent-run only: vetted canonical Pi paths. Empty is intentional; never fall back to ambient. */
  extensionPaths?: string[];
  skillPaths?: string[];
  /** Agent-run only: reverify the named per-user approval immediately before Pi spawn. */
  approvalName?: string;
  /** Agent-run only: recheck the transcript before invoking the child. */
  resumeOnly?: boolean;
}

export function joinLocalOrientation(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join("\n\n") || undefined;
}
