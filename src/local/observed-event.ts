import type { KeeperStreamEvent } from "@ideaspaces/sdk";
import type { LocalSendOptions } from "../commands/conversation.js";

/** Preserve JSONL: a post-run write failure is a terminal error, never a completed stream. */
export function observedEvent(event: KeeperStreamEvent, options?: LocalSendOptions): KeeperStreamEvent {
  try {
    return options?.onEvent?.(event) ?? event;
  } catch (err) {
    return { type: "error", error_type: "thread_snapshot", message: `Run completed but Thread snapshot was not appended (the response was streamed, not saved): ${err instanceof Error ? err.message : String(err)}` };
  }
}
