import { createHash } from "node:crypto";
import { entries, groups, exclusions } from "./data.js";
import { agentRunCapabilities } from "../local/agent-capabilities.js";
import type { BuildIdentity, Catalog, Entry } from "./types.js";

declare const __IDEASPACES_AGENT_CATALOG__: Catalog;

/** Canonical key order at every level; array order is the authored contract order. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function composeDescription(entry: Entry): string {
  return [entry.text.does, entry.text.use_when, entry.text.check, entry.text.bound].join("\n");
}
export function validateEntries(items: readonly Entry[]): void {
  const ids = new Set<string>();
  for (const entry of items) {
    if (ids.has(entry.id)) throw new Error(`Duplicate agent-tools id: ${entry.id}`);
    ids.add(entry.id);
    for (const [field, value] of Object.entries(entry.text)) {
      if (!value.trim()) throw new Error(`${entry.id}: empty text.${field}`);
      if ([...value].length > 300) throw new Error(`${entry.id}: text.${field} exceeds 300 characters`);
    }
    if (Buffer.byteLength(composeDescription(entry), "utf8") > 1200) throw new Error(`${entry.id}: composed description exceeds 1200 bytes`);
    if (entry.status === "retired" && !entry.refusal?.trim()) throw new Error(`${entry.id}: retired entry needs refusal`);
    if (entry.owner === "host" && (!entry.implemented_by?.length || entry.cli)) throw new Error(`${entry.id}: host definition must name implementers, not a CLI command`);
    const props = entry.parameters.properties ?? {};
    for (const name of entry.parameters.required ?? []) if (!props[name]) throw new Error(`${entry.id}: undeclared required parameter ${name}`);
    for (const name of [...(entry.cli?.positional ?? []), ...Object.keys(entry.cli?.flags ?? {})]) {
      if (!props[name]) throw new Error(`${entry.id}: CLI mapping has no parameter ${name}`);
    }
  }
  for (const entry of items) for (const call of entry.calls ?? []) if (!ids.has(call)) throw new Error(`${entry.id}: unknown call ${call}`);
}
export const threadsCapabilities = { schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: false };
export function buildCatalog(cli: BuildIdentity, protocol: BuildIdentity): Catalog {
  validateEntries(entries);
  return {
    schema: "ideaspaces.agent-tools", version: 1, cli, protocol,
    digest: `sha256:${createHash("sha256").update(canonicalJSON(entries)).digest("hex")}`,
    groups, entries, exclusions,
    capabilities: { threads: threadsCapabilities, agent: agentRunCapabilities() },
  };
}
/** The single-file sidecar must not depend on adjacent data files or a cwd. */
export function installedCatalog(): Catalog {
  if (typeof __IDEASPACES_AGENT_CATALOG__ !== "undefined") return __IDEASPACES_AGENT_CATALOG__;
  // Source/test execution has no claim to a built commit. Published bundles always inject metadata.
  return buildCatalog({ version: "unbuilt", commit: "unbuilt" }, { version: "unbuilt", commit: "unbuilt" });
}
export function discover(catalog: Catalog, selector?: string): Record<string, unknown> {
  const metadata = { schema: catalog.schema, version: catalog.version, cli: catalog.cli, protocol: catalog.protocol, digest: catalog.digest };
  if (!selector) return { ...metadata, groups: catalog.groups, unbounded: catalog.entries.filter(e => e.bound === "unbounded").map(e => e.id), exclusions: catalog.exclusions };
  const entry = catalog.entries.find(e => e.id === selector);
  // Group names such as write/commit are also command ids: group wins unless dotted.
  const group = catalog.groups.find(g => g.id === selector || g.job === selector);
  if (group) return { ...metadata, group, entries: catalog.entries.filter(e => e.job === group.job).map(e => ({ id: e.id, does: e.text.does, use_when: e.text.use_when })) };
  if (entry) return { ...metadata, entry, ...(entry.id === "threads.capabilities" ? { capabilities: catalog.capabilities.threads } : entry.id === "agent.capabilities" ? { capabilities: catalog.capabilities.agent } : {}) };
  throw new Error(`Unknown capabilities group or id: ${selector}. Run ideaspaces capabilities --json for groups.`);
}
export { entries, groups };
