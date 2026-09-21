/**
 * The launch-set resolver — pure. A turn loads exactly:
 *
 *   bundled  ∪  (declared by the agent repo, approved, not removed)  ∪  (added by the conversation)
 *
 * Nothing else: not the rest of the library, not an unapproved declaration.
 * The runtime-specific step (paths for pi, an `enabledPlugins` map for Claude)
 * happens after this, in the connector's send path, on the ids this returns.
 */

export interface LaunchOverrides {
  add: string[];
  remove: string[];
}

export interface ResolveInput {
  /** Ids that always load — the bundled pair for pi, the connector plugin for Claude. */
  bundled: string[];
  /** Sources the agent repo declares, in declaration order. */
  declared: string[];
  approved: (source: string) => boolean;
  overrides: LaunchOverrides;
}

export interface Refusal {
  source: string;
  reason: "unapproved" | "not-installed";
}

export interface ResolvedLaunch {
  /** Beyond bundled, in order: approved declarations not removed, then additions. */
  loaded: string[];
  refused: Refusal[];
}

/**
 * Parse `--extensions "+a,-b,c"`: `+` or no prefix adds, `-` removes. A removal
 * of something not declared is harmless; the conversation just says it does not
 * want it. Whitespace-only entries are dropped.
 */
export function parseLaunchOverrides(raw: string | undefined): LaunchOverrides {
  const out: LaunchOverrides = { add: [], remove: [] };
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (token.startsWith("-")) out.remove.push(token.slice(1).trim());
    else out.add.push(token.replace(/^\+/, "").trim());
  }
  out.add = out.add.filter(Boolean);
  out.remove = out.remove.filter(Boolean);
  return out;
}

export function resolveLaunch(input: ResolveInput): ResolvedLaunch {
  const bundled = new Set(input.bundled);
  const removed = new Set(input.overrides.remove);
  const loaded: string[] = [];
  const refused: Refusal[] = [];
  const seen = new Set<string>();

  for (const source of input.declared) {
    if (bundled.has(source) || removed.has(source) || seen.has(source)) continue;
    seen.add(source);
    if (!input.approved(source)) {
      refused.push({ source, reason: "unapproved" });
      continue;
    }
    loaded.push(source);
  }
  for (const source of input.overrides.add) {
    // A conversation's own addition is the person's choice in the moment — it
    // needs no agent-level approval, but it must already be in the library
    // (the connector checks that and reports `not-installed`).
    if (bundled.has(source) || removed.has(source) || seen.has(source)) continue;
    seen.add(source);
    loaded.push(source);
  }
  return { loaded, refused };
}
