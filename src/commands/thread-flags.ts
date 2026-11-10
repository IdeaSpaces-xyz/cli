import { allowedFlags } from "../agent-tools/flags.js";
import { entries } from "../agent-tools/data.js";

export type Flags = Record<string, string | boolean>;

export const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

const THREAD_FLAGS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  entries.filter(entry => entry.id.startsWith("threads.")).map(entry => [entry.id.slice(8), allowedFlags(entry.id, "local")]),
);
// The historical read spelling additionally accepts kind (open does not).
THREAD_FLAGS.read = new Set([...THREAD_FLAGS.open, "kind"]);

export function threadFlagError(verb: string, flags: Flags): string | undefined {
  const known = THREAD_FLAGS[verb];
  const unknown = known && Object.keys(flags).find((flag) => !known.has(flag));
  return unknown ? `Unknown flag for threads ${verb}: --${unknown}. Run ideaspaces threads --help for supported flags.` : undefined;
}

/** The only flags each hosted-Thread (x_<id>) verb takes; anything else is refused by name.
 * Checked instead of THREAD_FLAGS when the verb is hosted, so local verbs keep their own set. */
const HOSTED_VERB_FLAGS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  ["list", "open", "post", "new", "close", "rename", "send", "ack"].map(verb => [verb, allowedFlags(`threads.${verb}`, "hosted")]),
);

export function hostedVerbFlagError(verb: string, flags: Flags): string | undefined {
  const known = HOSTED_VERB_FLAGS[verb === "read" ? "open" : verb === "reply" ? "post" : verb];
  const unknown = known && Object.keys(flags).find((flag) => !known.has(flag));
  if (!unknown) return undefined;
  const label = unknown === "kind" && known.has("tags") ? " A hosted post's kind comes from its verb; a label goes in --tags." : "";
  return `--${unknown} is not supported by hosted threads ${verb}; it takes ${[...known].map((f) => `--${f}`).join(", ")}.${label}`;
}
