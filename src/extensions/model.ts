/**
 * Extensions across the local runtimes — one row shape for a pi package, a
 * Claude Code plugin, and a Codex plugin, so a client renders one list with a
 * runtime column instead of three vocabularies.
 *
 * Installed is not loaded. A row says what is on the machine (the user's
 * library, shared with the terminal) or what an agent repo declares; which rows
 * a turn actually loads is decided by the resolver (`resolve.ts`) from bundled +
 * agent-declared + the conversation's own choice.
 */

export const EXTENSION_RUNTIMES = ["pi", "claude", "codex"] as const;
export type ExtensionRuntime = (typeof EXTENSION_RUNTIMES)[number];

export function isExtensionRuntime(value: string): value is ExtensionRuntime {
  return (EXTENSION_RUNTIMES as readonly string[]).includes(value);
}

/** Where a row was declared. `user` is the runtime's own user scope (the
 * library); `agent` is the runtime's project config inside an agent repo. */
export type ExtensionScope = "user" | "agent";

export interface ExtensionRow {
  runtime: ExtensionRuntime;
  /** Stable identity within the runtime: a pi package source, a Claude/Codex `name@marketplace`. */
  id: string;
  /** Where it comes from, as the runtime names it (npm spec, git URL, marketplace, path). */
  source: string;
  version: string | null;
  scope: ExtensionScope;
  enabled: boolean;
  /** Where it is on disk, when installed. Null for a declaration that is not yet installed. */
  installPath: string | null;
  /** The agent repo that declared it (scope `agent`), else null. */
  declaredBy: string | null;
}

/** The catalog view: rows a marketplace offers that are not necessarily installed. */
export interface AvailableExtension {
  runtime: ExtensionRuntime;
  id: string;
  name: string;
  description: string | null;
  marketplace: string | null;
}

export interface ExtensionMarketplace {
  runtime: ExtensionRuntime;
  name: string;
  source: string;
}
