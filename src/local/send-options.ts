import type { KeeperStreamEvent, KeeperMessageStartEvent } from "@ideaspaces/sdk";
import type { ThreadReadReceipt } from "./thread-launch.js";

export type { ThreadReadReceipt };

/**
 * Which model ran, kept apart from which was asked for. `model_requested` is the
 * override passed to the runtime; `model_observed` is what the runtime itself
 * reported for this turn. Either is null when absent — a launcher must never
 * present a request, or the "local" tier label, as the model that ran.
 */
export interface LaunchModelReport {
  model_requested: string | null;
  model_observed: string | null;
}

/** One CLI-local disclosure shape for both runtime translators. Required reach fields catch drift. */
type LocalLaunchReach = Required<Pick<KeeperMessageStartEvent,
  "cwd" | "added_dirs" | "permission_mode" | "allowed_tools" | "runtime" | "model"
>> & Pick<KeeperMessageStartEvent, "extensions" | "trust" | "allowed_tools_semantics" | "shell_available"> & LaunchModelReport & {
  thread?: ThreadReadReceipt;
};

export type LocalMessageStartEvent = KeeperMessageStartEvent & LaunchModelReport & { thread?: ThreadReadReceipt };

export function discloseLaunch(event: Extract<KeeperStreamEvent, { type: "message_start" }>, reach: LocalLaunchReach): LocalMessageStartEvent {
  return { ...event, ...reach };
}

/** A runtime-reported model id, or null when it is missing or not a printable bounded string. */
export function reportedModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** Pi's `get_state` model object → `provider/id`, or null when Pi reported none. */
export function piStateModel(state: unknown): string | null {
  const model = (state as { model?: { provider?: unknown; id?: unknown } } | undefined)?.model;
  const id = reportedModel(model?.id);
  if (!id) return null;
  const provider = reportedModel(model?.provider);
  return provider ? `${provider}/${id}` : id;
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
