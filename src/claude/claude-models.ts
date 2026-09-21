/**
 * `ideaspaces claude-models` — the model roster and context window sizes
 * supported by the user's Claude Code binary, for the desktop model picker and
 * context meter.
 *
 * Claude Code exposes no `models` listing command, so the roster is keyed by
 * the installed binary's version against verified Anthropic releases.
 */

import { probeBinary, type ProbedBinary } from "../local/probe-binary.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export interface ClaudeModel {
  /** The ref to pass to `--claude-model` ("" for default, "opus", "sonnet", "fable", "haiku", "opusplan"). */
  ref: string;
  /** The canonical underlying model id (e.g. "claude-opus-5", "claude-sonnet-5"). */
  id: string;
  name: string;
  /** Context window in tokens (e.g. 1_000_000 for Opus 5, 200_000 for Haiku). */
  contextWindow: number;
  /** Maximum output tokens. */
  maxTokens: number;
  /** Whether this model is the default when no `--model` flag is passed. */
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

export interface ClaudeRoster {
  models: ClaudeModel[];
  capabilities: ClaudeCapabilities;
  verifiedVersion: string;
}

export interface ClaudeModelsResult {
  binary: ProbedBinary;
  models: ClaudeModel[];
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

/**
 * Verified model roster and runtime capabilities for a given Claude Code version.
 * Tested live against Claude Code 2.1.278.
 */
export function getClaudeRoster(version: string | null): ClaudeRoster {
  const semver = parseSemver(version);

  // Claude Code >= 2.1.0 (verified 2.1.278)
  if (semver && compareSemver(semver, [2, 1, 0]) >= 0) {
    return {
      models: [
        { ref: "", id: "claude-opus-5", name: "Claude Code default", contextWindow: 1_000_000, maxTokens: 64_000, isDefault: true },
        { ref: "opus", id: "claude-opus-5", name: "Opus", contextWindow: 1_000_000, maxTokens: 64_000 },
        { ref: "sonnet", id: "claude-sonnet-5", name: "Sonnet", contextWindow: 1_000_000, maxTokens: 64_000 },
        { ref: "fable", id: "claude-fable-5-1", name: "Fable", contextWindow: 1_000_000, maxTokens: 64_000 },
        { ref: "haiku", id: "claude-haiku-4-5-20251001", name: "Haiku", contextWindow: 200_000, maxTokens: 32_000 },
        { ref: "opusplan", id: "claude-sonnet-5", name: "Opus plans, Sonnet executes", contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
      capabilities: {
        compact: {
          supported: true,
          autocompact: {
            supported: true,
            minTokens: 100_000,
            maxTokens: 1_000_000,
          },
        },
      },
      verifiedVersion: "2.1.278",
    };
  }

  // Claude Code 2.0.x (pre-2.1)
  if (semver && compareSemver(semver, [2, 0, 0]) >= 0) {
    return {
      models: [
        { ref: "", id: "claude-3-7-sonnet-20250219", name: "Claude Code default", contextWindow: 200_000, maxTokens: 64_000, isDefault: true },
        { ref: "opus", id: "claude-3-opus-20240229", name: "Opus", contextWindow: 200_000, maxTokens: 4_096 },
        { ref: "sonnet", id: "claude-3-7-sonnet-20250219", name: "Sonnet", contextWindow: 200_000, maxTokens: 64_000 },
        { ref: "haiku", id: "claude-3-5-haiku-20241022", name: "Haiku", contextWindow: 200_000, maxTokens: 8_192 },
        { ref: "opusplan", id: "claude-3-7-sonnet-20250219", name: "Opus plans, Sonnet executes", contextWindow: 200_000, maxTokens: 64_000 },
      ],
      capabilities: {
        compact: {
          supported: false,
          autocompact: {
            supported: false,
            minTokens: 0,
            maxTokens: 0,
          },
        },
      },
      verifiedVersion: "2.0.0",
    };
  }

  // Legacy fallback (null / unknown version / < 2.0.0)
  return {
    models: [
      { ref: "", id: "claude-default", name: "Claude Code default", contextWindow: 200_000, maxTokens: 64_000, isDefault: true },
      { ref: "opus", id: "claude-opus", name: "Opus", contextWindow: 200_000, maxTokens: 4_096 },
      { ref: "sonnet", id: "claude-sonnet", name: "Sonnet", contextWindow: 200_000, maxTokens: 64_000 },
      { ref: "haiku", id: "claude-haiku", name: "Haiku", contextWindow: 200_000, maxTokens: 8_192 },
    ],
    capabilities: {
      compact: {
        supported: false,
        autocompact: {
          supported: false,
          minTokens: 0,
          maxTokens: 0,
        },
      },
    },
    verifiedVersion: "fallback",
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

export function formatClaudeModelsHuman(res: ClaudeModelsResult): string {
  const out: string[] = [];
  const v = res.binary.version ? ` (${res.binary.version})` : "";
  out.push(`Claude Code: ${res.binary.present ? `present${v}` : `not found (${res.binary.path})`}`);
  out.push(`Verified against: ${res.verifiedVersion}`);
  out.push("");
  out.push("Models:");
  for (const m of res.models) {
    const def = m.isDefault ? " [default]" : "";
    const ref = m.ref ? ` --model ${m.ref}` : " (no flag)";
    out.push(`  - ${m.name} (${formatTokens(m.contextWindow)} context)${def}${ref}`);
  }
  out.push("");
  out.push("Capabilities:");
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
  description: "List the models, context windows, and capabilities of your Claude Code binary",
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
    const roster = getClaudeRoster(binary.version);
    const result: ClaudeModelsResult = {
      binary,
      models: roster.models,
      capabilities: roster.capabilities,
      verifiedVersion: roster.verifiedVersion,
    };
    output.result(result, formatClaudeModelsHuman(result));
    return 0;
  },
};
