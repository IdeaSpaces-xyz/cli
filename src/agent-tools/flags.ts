import { entries } from "./data.js";
import type { Entry } from "./types.js";

const definitions: readonly Entry[] = entries;
export function allowedFlags(id: string, route?: "local" | "hosted"): ReadonlySet<string> {
  const entry = definitions.find(e => e.id === id);
  if (!entry?.cli) throw new Error(`No CLI contract for ${id}`);
  const subset = route === "local" ? entry.cli.local_flags : route === "hosted" ? entry.cli.hosted_flags : undefined;
  return new Set(subset ?? Object.values(entry.cli.flags).flatMap(mapping => [mapping.flag.replace(/^--/, ""), ...(mapping.aliases ?? []).map(a => a.replace(/^-+/, ""))]));
}
export function resolveEntry(command: string, args: string[]): Entry | undefined {
  const verb = args[0];
  const alias = `${command} ${verb ?? ""}`.trim();
  const aliased = definitions.find(e => e.aliases?.includes(alias));
  if (aliased) return aliased;
  if (command === "map" && !["create", "add", "remove", "select"].includes(verb)) return definitions.find(e => e.id === "map.read");
  if (command === "skills" && verb !== "sync") return definitions.find(e => e.id === "skills.read");
  if (command === "spaces" && !verb) return definitions.find(e => e.id === "spaces.list");
  if (command === "request" && verb?.startsWith("n_")) return definitions.find(e => e.id === "request.ask");
  return definitions.find(e => e.owner === "cli" && e.cli?.argv[0] === command && e.cli.argv.length > 1 && e.cli.argv[1] === verb)
    ?? definitions.find(e => e.owner === "cli" && e.cli?.argv[0] === command && e.cli.argv.length === 1);
}
/** Shared by the real entrypoint and tests; runs before auth, reads or writes. */
export function catalogFlagError(command: string, args: string[], flags: Record<string, unknown>): string | undefined {
  const entry = resolveEntry(command, args);
  if (!entry || entry.status !== "active") return undefined;
  // A recognized compatibility refusal is not an advertised capability.
  if (entry.id === "look" && flags.new !== undefined) return "--new is a cursor action, not a look rung; use ideaspaces threads open --new.";
  const allowed = new Set([...allowedFlags(entry.id), ...(entry.cli?.alias_flags?.[`${command} ${args[0]}`] ?? [])]);
  const unknown = Object.keys(flags).find(flag => !allowed.has(flag));
  return unknown ? `Unknown flag for ${entry.cli!.argv.join(" ")}: --${unknown}. Run ideaspaces ${command} --help for supported flags.` : undefined;
}
