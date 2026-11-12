/**
 * `ideaspaces claude-models` — the models the user's Claude Code binary offers,
 * for the desktop model picker and context meter.
 *
 * What is listed is what the binary says: each of Claude Code's aliases, with
 * the model the binary reports for it (`claude-aliases.ts`). A new Claude model
 * reaches this list the day Claude Code resolves an alias to it, with no CLI
 * release. The versioned table below gives only defaults: a context window and
 * an output limit for a model before a turn has reported its own, and the
 * compaction capabilities of the binary's version. It never decides what is
 * listed, and no model id comes from it.
 */

import { probeBinary, type ProbedBinary } from "../local/probe-binary.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import { resolveClaudeAliases, type ResolvedAlias } from "./claude-aliases.js";

export interface ClaudeModel {
  /** The alias to pass as `--model` ("" for no flag: Claude Code's default; "opus", "sonnet", "haiku", "fable", "opusplan"). */
  ref: string;
  /** The model Claude Code reported for this alias, at this call (e.g. "claude-fable-5-2"). */
  id: string;
  /** A person's name for it, made from the reported id ("Fable 5.2"). */
  name: string;
  /** Always true: the id is what the binary reported, never a typed guess. */
  reported: true;
  /** Context window in tokens. A default until a turn reports the model's own (`window`). */
  contextWindow: number;
  /** Maximum output tokens, a default as `contextWindow` is. */
  maxTokens: number;
  /** Where `contextWindow` and `maxTokens` come from: this CLI's defaults for the model's family. */
  window: "default";
  /** Whether this is the model Claude Code runs when no `--model` flag is passed. */
  isDefault?: boolean;
}

export interface ClaudeCompactionCapabilities {
  supported: boolean;
  autocompact: {
    supported: boolean;
    minTokens: number;
    maxTokens: number;
  };
}

export interface ClaudeCapabilities {
  compact: ClaudeCompactionCapabilities;
}

/** A model's window defaults. */
export interface ClaudeWindow {
  contextWindow: number;
  maxTokens: number;
}

/** What this CLI assumes about a Claude Code version: window defaults and capabilities, never models. */
export interface ClaudeDefaults {
  /** Window defaults by model family ("opus", "sonnet", "haiku", "fable"). */
  families: Record<string, ClaudeWindow>;
  /** For a model whose family is not known here. */
  other: ClaudeWindow;
  capabilities: ClaudeCapabilities;
  verifiedVersion: string;
}

export interface ClaudeModelList {
  models: ClaudeModel[];
  /** Why the list is empty or short: what the binary said when it could not name a model. Null when every alias resolved. */
  modelsDetail: string | null;
}

export interface ClaudeModelsResult extends ClaudeModelList {
  binary: ProbedBinary;
  capabilities: ClaudeCapabilities;
  verifiedVersion: string;
}

/** Parse `X.Y.Z` semver into numbers. Returns null for non-semver strings. */
export function parseSemver(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/** Compare two semver triples: returns >0 if a > b, <0 if a < b, 0 if equal. */
export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

const NO_COMPACT: ClaudeCapabilities = { compact: { supported: false, autocompact: { supported: false, minTokens: 0, maxTokens: 0 } } };
const COMPACT: ClaudeCapabilities = { compact: { supported: true, autocompact: { supported: true, minTokens: 100_000, maxTokens: 1_000_000 } } };

/**
 * Defaults for a Claude Code version. Capabilities were tested against 2.1.278;
 * the 2.1.305 windows are Anthropic catalogue estimates (pi-ai 1.3.0), and
 * Claude Code 2.1.322 reported 1M / 128k in `modelUsage` for `claude-haiku-5-5`.
 */
export function getClaudeDefaults(version: string | null): ClaudeDefaults {
  const semver = parseSemver(version);
  if (semver && compareSemver(semver, [2, 1, 305]) >= 0) {
    const w = { contextWindow: 1_000_000, maxTokens: 128_000 };
    return { families: { opus: w, sonnet: w, haiku: w, fable: w }, other: w, capabilities: COMPACT, verifiedVersion: "2.1.305" };
  }
  if (semver && compareSemver(semver, [2, 1, 0]) >= 0) {
    const w = { contextWindow: 1_000_000, maxTokens: 64_000 };
    return {
      families: { opus: w, sonnet: w, fable: w, haiku: { contextWindow: 200_000, maxTokens: 32_000 } },
      other: w, capabilities: COMPACT, verifiedVersion: "2.1.278",
    };
  }
  if (semver && compareSemver(semver, [2, 0, 0]) >= 0) {
    return {
      families: {
        opus: { contextWindow: 200_000, maxTokens: 4_096 },
        sonnet: { contextWindow: 200_000, maxTokens: 64_000 },
        haiku: { contextWindow: 200_000, maxTokens: 8_192 },
      },
      other: { contextWindow: 200_000, maxTokens: 64_000 }, capabilities: NO_COMPACT, verifiedVersion: "2.0.0",
    };
  }
  return {
    families: {
      opus: { contextWindow: 200_000, maxTokens: 4_096 },
      sonnet: { contextWindow: 200_000, maxTokens: 64_000 },
      haiku: { contextWindow: 200_000, maxTokens: 8_192 },
    },
    other: { contextWindow: 200_000, maxTokens: 64_000 }, capabilities: NO_COMPACT, verifiedVersion: "fallback",
  };
}

const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]+\])?$/;

/** The family a model id names ("claude-fable-5-2" → "fable"), or null. */
export function modelFamily(id: string): string | null {
  return MODEL_ID.exec(id)?.[1] ?? null;
}

/** A person's name for a model id: "claude-fable-5-2" → "Fable 5.2". An id that doesn't parse is its own name. */
export function modelName(id: string): string {
  const m = MODEL_ID.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** What `opusplan` is called: a mode of two models, not one. */
const OPUSPLAN_NAME = "Opus plans, Sonnet executes";

/**
 * The list, from what the binary reported. One entry per alias it resolved, in
 * Claude Code's order; the defaults give only the window. An alias the binary
 * did not resolve is left out, and the first reason is kept for `modelsDetail`.
 */
export function claudeModelList(resolved: readonly ResolvedAlias[], defaults: ClaudeDefaults): ClaudeModelList {
  const models: ClaudeModel[] = [];
  const missing: string[] = [];
  for (const alias of resolved) {
    if (!alias.model) {
      missing.push(alias.detail ?? `Claude Code does not resolve ${alias.ref ? `--model ${alias.ref}` : "the default model"}`);
      continue;
    }
    const family = modelFamily(alias.model);
    const window = (family && defaults.families[family]) || defaults.other;
    models.push({
      ref: alias.ref,
      id: alias.model,
      name: alias.ref === "opusplan" ? OPUSPLAN_NAME : modelName(alias.model),
      reported: true,
      contextWindow: window.contextWindow,
      maxTokens: window.maxTokens,
      window: "default",
      ...(alias.ref === "" ? { isDefault: true } : {}),
    });
  }
  return { models, modelsDetail: missing.length ? missing[0] : null };
}

/** Ask a present binary for its models; an absent one has none. */
export async function probeClaudeModels(binary: ProbedBinary, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeModelList & { defaults: ClaudeDefaults }> {
  const defaults = getClaudeDefaults(binary.version);
  if (!binary.present) return { models: [], modelsDetail: `${binary.path} is not installed or not on PATH`, defaults };
  return { ...claudeModelList(await resolveClaudeAliases(binary.path, env), defaults), defaults };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

export function formatClaudeModelsHuman(res: ClaudeModelsResult): string {
  const out: string[] = [];
  const v = res.binary.version ? ` (${res.binary.version})` : "";
  out.push(`Claude Code: ${res.binary.present ? `present${v}` : `not found (${res.binary.path})`}`);
  out.push("");
  if (res.models.length) {
    out.push("Models, as Claude Code reports them:");
    for (const m of res.models) {
      const def = m.isDefault ? " [default]" : "";
      const ref = m.ref ? ` --model ${m.ref}` : " (no flag)";
      out.push(`  - ${m.name}: ${m.id}, ${formatTokens(m.contextWindow)} context (default)${def}${ref}`);
    }
  } else {
    out.push("Models: none named by Claude Code.");
  }
  if (res.modelsDetail) out.push(`  Not listed: ${res.modelsDetail}`);
  out.push("");
  out.push(`Capabilities (defaults for ${res.verifiedVersion}):`);
  out.push(`  - Compact: ${res.capabilities.compact.supported ? "yes" : "no"}`);
  out.push(
    `  - Auto-compact: ${
      res.capabilities.compact.autocompact.supported
        ? `yes (${formatTokens(res.capabilities.compact.autocompact.minTokens)}–${formatTokens(res.capabilities.compact.autocompact.maxTokens)})`
        : "no"
    }`,
  );
  return out.join("\n");
}

export const claudeModelsCommand: CommandDef = {
  name: "claude-models",
  description: "List the models your Claude Code binary reports for its aliases, with window defaults and capabilities",
  usage: "ideaspaces claude-models [--claude-bin <path>] [--json]",
  examples: [
    "ideaspaces claude-models",
    "ideaspaces claude-models --json",
    "ideaspaces claude-models --claude-bin /opt/homebrew/bin/claude --json",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const claudeBin = typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : "claude";
    const binary = probeBinary(claudeBin);
    const { models, modelsDetail, defaults } = await probeClaudeModels(binary);
    const result: ClaudeModelsResult = {
      binary,
      models,
      modelsDetail,
      capabilities: defaults.capabilities,
      verifiedVersion: defaults.verifiedVersion,
    };
    output.result(result, formatClaudeModelsHuman(result));
    return 0;
  },
};
