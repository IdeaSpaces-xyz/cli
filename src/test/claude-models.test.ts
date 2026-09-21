import { describe, it, expect } from "vitest";
import {
  getClaudeRoster,
  parseSemver,
  compareSemver,
  formatClaudeModelsHuman,
  type ClaudeModelsResult,
} from "../claude/claude-models.js";

describe("parseSemver and compareSemver", () => {
  it("parses valid semver triples", () => {
    expect(parseSemver("2.1.278")).toEqual([2, 1, 278]);
    expect(parseSemver("2.1.278 (Claude Code)")).toEqual([2, 1, 278]);
    expect(parseSemver("2.0.0")).toEqual([2, 0, 0]);
  });

  it("returns null for non-semver strings or null", () => {
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("custom-build")).toBeNull();
  });

  it("compares semver triples correctly", () => {
    expect(compareSemver([2, 1, 0], [2, 0, 0])).toBeGreaterThan(0);
    expect(compareSemver([2, 1, 278], [2, 1, 0])).toBeGreaterThan(0);
    expect(compareSemver([2, 1, 0], [2, 1, 0])).toBe(0);
    expect(compareSemver([1, 9, 0], [2, 0, 0])).toBeLessThan(0);
  });
});

describe("getClaudeRoster — version lookup and fallbacks", () => {
  it("known version >= 2.1.0 returns 1M-window models and compaction support", () => {
    const roster = getClaudeRoster("2.1.278");
    expect(roster.verifiedVersion).toBe("2.1.278");

    // All expected aliases are present
    const refs = roster.models.map((m) => m.ref);
    expect(refs).toContain("");
    expect(refs).toContain("opus");
    expect(refs).toContain("sonnet");
    expect(refs).toContain("fable");
    expect(refs).toContain("haiku");
    expect(refs).toContain("opusplan");

    // Distinct windows verified: 1M for Opus/Sonnet/Fable/Opusplan, 200k for Haiku
    const opus = roster.models.find((m) => m.ref === "opus");
    const sonnet = roster.models.find((m) => m.ref === "sonnet");
    const fable = roster.models.find((m) => m.ref === "fable");
    const haiku = roster.models.find((m) => m.ref === "haiku");
    const def = roster.models.find((m) => m.ref === "");

    expect(opus?.contextWindow).toBe(1_000_000);
    expect(sonnet?.contextWindow).toBe(1_000_000);
    expect(fable?.contextWindow).toBe(1_000_000);
    expect(haiku?.contextWindow).toBe(200_000);
    expect(def?.contextWindow).toBe(1_000_000);
    expect(def?.isDefault).toBe(true);

    // Compaction capability
    expect(roster.capabilities.compact.supported).toBe(true);
    expect(roster.capabilities.compact.autocompact.supported).toBe(true);
    expect(roster.capabilities.compact.autocompact.minTokens).toBe(100_000);
    expect(roster.capabilities.compact.autocompact.maxTokens).toBe(1_000_000);
  });

  it("future major version >= 3.0.0 returns unverified newer bucket", () => {
    const roster = getClaudeRoster("3.0.1");
    expect(roster.verifiedVersion).toBe("unverified newer (>=3.0)");
    expect(roster.models.length).toBeGreaterThanOrEqual(4);
  });

  it("version 2.0.x returns 200k-window models without autocompact", () => {
    const roster = getClaudeRoster("2.0.5");
    expect(roster.verifiedVersion).toBe("2.0.0");
    for (const m of roster.models) {
      expect(m.contextWindow).toBe(200_000);
    }
    expect(roster.capabilities.compact.supported).toBe(false);
    expect(roster.capabilities.compact.autocompact.supported).toBe(false);
  });

  it("unknown / null version returns safe fallback roster", () => {
    const roster = getClaudeRoster(null);
    expect(roster.verifiedVersion).toBe("fallback");
    expect(roster.models.length).toBeGreaterThanOrEqual(4);
    for (const m of roster.models) {
      expect(m.contextWindow).toBe(200_000);
    }
    expect(roster.capabilities.compact.supported).toBe(false);
    expect(roster.capabilities.compact.autocompact.supported).toBe(false);
  });
});

describe("formatClaudeModelsHuman", () => {
  it("formats human output with model roster and capabilities", () => {
    const result: ClaudeModelsResult = {
      binary: { present: true, path: "claude", version: "2.1.278" },
      ...getClaudeRoster("2.1.278"),
    };
    const human = formatClaudeModelsHuman(result);
    expect(human).toContain("Claude Code: present (2.1.278)");
    expect(human).toContain("Opus (1M context)");
    expect(human).toContain("Haiku (200k context)");
    expect(human).toContain("Compact: yes");
    expect(human).toContain("Auto-compact: yes (100k–1M)");
  });
});
