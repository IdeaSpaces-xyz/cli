// The local runtime seam — `conversation … --local` has more than one runner
// behind it (pi, Claude Code), and `--runtime` picks which. This dispatcher is
// pure over a table of ops so the router composes it and the core commands see
// one `LocalConversationOps`, never a runtime.

import type { LocalConversationOps } from "./commands/conversation.js";
import type { Output } from "./output.js";

export const LOCAL_RUNTIMES = ["pi", "claude"] as const;
export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number];
export const DEFAULT_LOCAL_RUNTIME: LocalRuntime = "pi";

type Flags = Record<string, string | boolean>;

export function isLocalRuntime(value: string): value is LocalRuntime {
  return (LOCAL_RUNTIMES as readonly string[]).includes(value);
}

/** The runtime a flag set names — `--runtime=<name>`, default pi. Throws on an unknown name. */
export function selectLocalRuntime(flags: Flags): LocalRuntime {
  const raw = flags.runtime;
  if (raw === undefined || raw === false) return DEFAULT_LOCAL_RUNTIME;
  if (typeof raw !== "string" || !isLocalRuntime(raw)) {
    throw new Error(`Unknown local runtime "${String(raw)}". Valid values: ${LOCAL_RUNTIMES.join(", ")}`);
  }
  return raw;
}

/** One `LocalConversationOps` that routes each call to the runtime `--runtime` names. */
export function composeLocalConversationOps(runtimes: Record<LocalRuntime, LocalConversationOps>): LocalConversationOps {
  const pick = (flags: Flags, output: Output): LocalConversationOps | null => {
    try {
      return runtimes[selectLocalRuntime(flags)];
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  return {
    send: async (flags, output) => (await pick(flags, output))?.send(flags, output) ?? 1,
    createNew: (flags, output) => pick(flags, output)?.createNew(flags, output) ?? 1,
    get: (flags, output) => pick(flags, output)?.get(flags, output) ?? 1,
    list: (flags, output) => pick(flags, output)?.list(flags, output) ?? 1,
  };
}
