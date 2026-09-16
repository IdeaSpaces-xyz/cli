/**
 * `ideaspaces get <space-url|dir>` — one door, plan-first.
 *
 * Given a Space URL, a person has two honest ways to bring it home, and they
 * are not the same thing: **clone** keeps the Space's identity and needs
 * transport authority (fetch, maybe push, full history); **fork** mints a new
 * identity and carries no source history. A local folder that is already a
 * clone can be **linked** to its Space. `get` never chooses among these — the
 * distribution contract keeps that decision explicit. It shows the truth for
 * every mode the address admits and mutates nothing until `--yes --as <mode>`
 * names one, then runs that mode's own command. `clone`, `fork`, and `link`
 * stay as the explicit verbs; `get` is the door that shows what each would do.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchAuthMe,
  getSpace,
  optionalAuthRead,
  UnauthorizedError,
  type AuthMeRepo,
  type PublicSpaceResult,
} from "../auth/api.js";
import { loadConfig, loadOptionalAuthConfig } from "../auth/credentials.js";
import { isInsideWorkTree, originUrl } from "../git.js";
import { createOutput, type Output } from "../output.js";
import { canonicalRepoUrl, parseRepoLocator } from "../repo-locator.js";
import { hasRootAction } from "../root-actions.js";
import type { CommandDef, GlobalFlags } from "../types.js";
import { cloneCommand } from "./clone.js";
import { forkCommand } from "./fork.js";
import { linkCommand } from "./link.js";

export const GET_MODES = ["clone", "fork", "link"] as const;
export type GetMode = (typeof GET_MODES)[number];

type Truth = "allowed" | "not allowed" | "login required" | "unknown";

export interface GetPlan {
  address: string;
  kind: "space" | "folder";
  root_node_id?: string;
  name?: string;
  canonical_url?: string;
  modes: {
    clone?: { available: boolean; fetch: Truth; push: Truth; history: "full" };
    fork?: { available: boolean; copy: Truth; history: "none" };
    link?: { available: boolean; origin: string | null; reason?: string };
  };
  logged_in: boolean;
}

const USAGE = "ideaspaces get <space-url> [dest-dir] [--yes --as clone|fork] [--name <local-name>] | ideaspaces get <dir> [space] [--yes --as link] [--json]";

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/** What each mode would do for a local folder: only link applies. */
function planFolder(dir: string): GetPlan {
  const inside = isInsideWorkTree(dir);
  const origin = inside ? originUrl(dir) : null;
  return {
    address: dir,
    kind: "folder",
    modes: {
      link: inside
        ? origin
          ? { available: true, origin }
          : { available: false, origin: null, reason: "no `origin` remote — cannot tell which Space it belongs to" }
        : { available: false, origin: null, reason: "not a git repository" },
    },
    logged_in: loadConfig() !== null,
  };
}

/** What each mode would do for a Space URL, from the catalog and the public read. */
async function planSpace(address: string, output: Output): Promise<GetPlan | null> {
  const auth = loadOptionalAuthConfig();
  let rootNodeId: string;
  try {
    rootNodeId = parseRepoLocator(address, auth.apiUrl).rootNodeId;
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    return null;
  }

  const loggedIn = loadConfig() !== null;
  let catalog: AuthMeRepo | undefined;
  if (loggedIn) {
    try {
      const me = await fetchAuthMe(auth as { apiUrl: string; apiKey: string });
      catalog = me.repos.find((r) => r.root_node_id === rootNodeId);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return null;
      }
      throw err;
    }
  }

  let source: PublicSpaceResult | null = null;
  try {
    const read = await optionalAuthRead(auth, (config) => getSpace(config, rootNodeId));
    source = read.value;
  } catch (err) {
    // A private Space answers not-found to the public read; the catalog row,
    // if any, still says what clone can do.
    if (!/→ (?:401|403|404):/.test(err instanceof Error ? err.message : String(err))) throw err;
  }

  // Clone truth comes from the account catalog; a known-link collaborator
  // without a catalog row still has git as the authority, so "unknown" is
  // honest there rather than "not allowed".
  const fetch: Truth = catalog ? (hasRootAction(catalog, "clone") ? "allowed" : "not allowed") : loggedIn ? "unknown" : "login required";
  const push: Truth = catalog ? (hasRootAction(catalog, "collaborate") ? "allowed" : "not allowed") : loggedIn ? "unknown" : "login required";
  const copy: Truth = source
    ? source.copy_enabled
      ? source.login_required_to_copy && !loggedIn
        ? "login required"
        : "allowed"
      : "not allowed"
    : "not allowed";

  return {
    address,
    kind: "space",
    root_node_id: rootNodeId,
    ...(source?.name ? { name: source.name } : catalog?.name ? { name: catalog.name } : {}),
    canonical_url: canonicalRepoUrl(auth.apiUrl, rootNodeId),
    modes: {
      clone: { available: fetch === "allowed" || fetch === "unknown", fetch, push, history: "full" },
      fork: { available: copy === "allowed", copy, history: "none" },
    },
    logged_in: loggedIn,
  };
}

function renderPlan(plan: GetPlan): string {
  const lines: string[] = [];
  if (plan.kind === "space") {
    lines.push(`Space: ${plan.canonical_url}${plan.name ? ` — ${plan.name}` : ""}`);
    const c = plan.modes.clone!;
    lines.push(
      "",
      `Collaborate on this Space (clone) — same identity, full history${c.available ? "" : " — not available"}`,
      `  fetch: ${c.fetch}`,
      `  push:  ${c.push}`,
    );
    const f = plan.modes.fork!;
    lines.push(
      "",
      `Make my own version (fork) — new identity, no source history${f.available ? "" : " — not available"}`,
      `  copy:  ${f.copy}`,
    );
    if (!plan.logged_in) lines.push("", "Not logged in: `ideaspaces login` reveals what your account may clone.");
  } else {
    const l = plan.modes.link!;
    lines.push(`Folder: ${plan.address}`);
    lines.push(
      "",
      `Bind this clone to its Space (link)${l.available ? "" : " — not available"}`,
      l.available ? `  origin: ${l.origin}` : `  ${l.reason}`,
    );
  }
  const available = (Object.entries(plan.modes) as Array<[GetMode, { available: boolean }]>)
    .filter(([, m]) => m.available)
    .map(([mode]) => mode);
  lines.push("", "Nothing changed.");
  if (available.length) {
    lines.push(`Choose one: ${available.map((m) => `ideaspaces get ${quote(plan.address)} --yes --as ${m}`).join("   |   ")}`);
  }
  return lines.join("\n");
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

/** Run the chosen mode's own command — get adds no second implementation. */
async function execute(
  mode: GetMode,
  plan: GetPlan,
  args: string[],
  flags: Record<string, string | boolean>,
  global: GlobalFlags,
  output: Output,
): Promise<number> {
  const chosen = plan.modes[mode];
  if (!chosen) {
    output.error(`--as ${mode} does not apply to ${plan.kind === "space" ? "a Space URL" : "a local folder"}.`);
    return 1;
  }
  if (!chosen.available) {
    output.error(`${mode} is not available here:\n${renderPlan(plan)}`);
    return 1;
  }
  const rest = args.slice(1);
  switch (mode) {
    case "clone":
      return cloneCommand.run([plan.address, ...rest], flags, global);
    case "fork":
      return forkCommand.run([plan.address, ...rest], flags, global);
    case "link":
      return linkCommand.run([plan.address, ...rest], flags, global);
  }
}

export const getCommand: CommandDef = {
  name: "get",
  description: "Bring a Space home — shows what clone, fork, or link would do; --yes --as names one",
  usage: USAGE,
  examples: [
    "ideaspaces get https://ideaspaces.xyz/repos/n_0123456789abcdef01234567            # the plan: what each mode would do",
    "ideaspaces get https://ideaspaces.xyz/repos/n_0123456789abcdef01234567 --yes --as clone",
    "ideaspaces get https://ideaspaces.xyz/repos/n_0123456789abcdef01234567 ./mine --yes --as fork",
    "ideaspaces get ./theone --yes --as link                # bind an existing clone to the Space its origin names",
    "ideaspaces get ./theone alice/theone --yes --as link   # …or to a named Space (link's second argument)",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const address = args[0]?.trim();
    if (!address) {
      output.error(`Usage: ${USAGE}`);
      return 1;
    }
    const as = flags.as;
    if (as !== undefined && !(GET_MODES as readonly string[]).includes(String(as))) {
      output.error(`--as must be one of ${GET_MODES.join(", ")}`);
      return 1;
    }
    if (as !== undefined && !global.yes) {
      output.error("--as names the mode to run; add --yes to run it. Without --yes, get only shows the plan.");
      return 1;
    }

    let plan: GetPlan | null;
    try {
      if (isUrl(address)) {
        plan = await planSpace(address, output);
      } else if (existsSync(address) && statSync(address).isDirectory()) {
        plan = planFolder(resolve(address));
      } else {
        output.error(`Not a Space URL or an existing folder: ${address}`);
        return 1;
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (!plan) return 1;

    if (!global.yes) {
      output.result(plan, renderPlan(plan));
      return 0;
    }
    if (as === undefined) {
      output.error(`--yes needs a mode: --as clone, --as fork, or --as link. The plan:\n${renderPlan(plan)}`);
      return 1;
    }
    return execute(as as GetMode, plan, args, flags, global, output);
  },
};
