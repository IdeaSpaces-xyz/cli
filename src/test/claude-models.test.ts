import { describe, it, expect } from "vitest";
import {
  claudeModelList,
  compareSemver,
  formatClaudeModelsHuman,
  getClaudeDefaults,
  modelFamily,
  modelName,
  parseSemver,
  type ClaudeModelsResult,
} from "../claude/claude-models.js";
import type { ResolvedAlias } from "../claude/claude-aliases.js";

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

describe("modelName and modelFamily, from the id Claude Code reports", () => {
  it("names a model from its id, whatever its version", () => {
    expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-opus-5")).toBe("Opus 5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(modelName("claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5");
    expect(modelName("claude-quill-7-1")).toBe("Quill 7.1");
  });
  it("an id that doesn't parse is its own name and has no family", () => {
    expect(modelName("us.anthropic.claude-opus-5-5-v1:0")).toBe("us.anthropic.claude-opus-5-5-v1:0");
    expect(modelFamily("us.anthropic.claude-opus-5-5-v1:0")).toBeNull();
    expect(modelFamily("claude-fable-5-2")).toBe("fable");
  });
});

const reported = (pairs: Array<[string, string | null]>): ResolvedAlias[] =>
  pairs.map(([ref, model]) => (model ? { ref, model } : { ref, model: null, detail: `Claude Code does not resolve --model ${ref}` }));

describe("claudeModelList: the roster gives only defaults and never decides what is listed", () => {
  it("lists exactly what the binary reported, with ids no roster has seen", () => {
    const list = claudeModelList(reported([
      ["", "claude-opus-7-1"], ["opus", "claude-opus-7-1"], ["sonnet", "claude-sonnet-7"],
      ["haiku", "claude-haiku-6-5"], ["fable", "claude-fable-5-2"], ["opusplan", "claude-sonnet-7"],
    ]), getClaudeDefaults("2.1.322"));
    expect(list.models.map((m) => [m.ref, m.id, m.name])).toEqual([
      ["", "claude-opus-7-1", "Opus 7.1"], ["opus", "claude-opus-7-1", "Opus 7.1"], ["sonnet", "claude-sonnet-7", "Sonnet 7"],
      ["haiku", "claude-haiku-6-5", "Haiku 6.5"], ["fable", "claude-fable-5-2", "Fable 5.2"],
      ["opusplan", "claude-sonnet-7", "Opus plans, Sonnet executes"],
    ]);
    expect(list.models.every((m) => m.reported === true && m.window === "default")).toBe(true);
    expect(list.models.find((m) => m.ref === "")?.isDefault).toBe(true);
    expect(list.models.filter((m) => m.isDefault)).toHaveLength(1);
    expect(list.modelsDetail).toBeNull();
  });

  it("an alias the binary did not resolve is left out, with the reason kept", () => {
    const list = claudeModelList(reported([["opus", "claude-opus-5-5"], ["fable", null]]), getClaudeDefaults("2.1.322"));
    expect(list.models.map((m) => m.ref)).toEqual(["opus"]);
    expect(list.modelsDetail).toBe("Claude Code does not resolve --model fable");
  });

  it("a binary that resolved nothing lists nothing: the roster does not fill in", () => {
    for (const version of [null, "2.0.5", "2.1.278", "2.1.305", "2.1.322"]) {
      const list = claudeModelList(reported([["", null], ["opus", null], ["sonnet", null]]), getClaudeDefaults(version));
      expect(list.models).toEqual([]);
      expect(list.modelsDetail).toMatch(/does not resolve/);
    }
  });

  it("windows come from the version's family defaults, the fallback for a family it doesn't know", () => {
    const at278 = claudeModelList(reported([["haiku", "claude-haiku-4-5-20251001"], ["opus", "claude-opus-5"], ["x", "claude-quill-1"]]), getClaudeDefaults("2.1.278"));
    expect(at278.models.map((m) => [m.id, m.contextWindow, m.maxTokens])).toEqual([
      ["claude-haiku-4-5-20251001", 200_000, 32_000], ["claude-opus-5", 1_000_000, 64_000], ["claude-quill-1", 1_000_000, 64_000],
    ]);
    const at322 = claudeModelList(reported([["haiku", "claude-haiku-5-5"]]), getClaudeDefaults("2.1.322"));
    expect(at322.models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
    const old = claudeModelList(reported([["opus", "claude-3-opus-20240229"]]), getClaudeDefaults("2.0.5"));
    expect(old.models[0]).toMatchObject({ id: "claude-3-opus-20240229", name: "claude-3-opus-20240229", contextWindow: 200_000 });
  });
});

describe("getClaudeDefaults: capabilities by version", () => {
  it("2.1.x compacts, with autocompact bounds", () => {
    for (const version of ["2.1.278", "2.1.305", "2.2.0"]) {
      expect(getClaudeDefaults(version).capabilities.compact.autocompact).toEqual({ supported: true, minTokens: 100_000, maxTokens: 1_000_000 });
    }
    expect(getClaudeDefaults("2.1.322").verifiedVersion).toBe("2.1.305");
    expect(getClaudeDefaults("2.1.304").verifiedVersion).toBe("2.1.278");
  });
  it("2.0.x and unknown versions do not compact", () => {
    expect(getClaudeDefaults("2.0.5").capabilities.compact.supported).toBe(false);
    expect(getClaudeDefaults("2.0.5").verifiedVersion).toBe("2.0.0");
    expect(getClaudeDefaults(null).capabilities.compact.supported).toBe(false);
    expect(getClaudeDefaults(null).verifiedVersion).toBe("fallback");
  });
});

describe("formatClaudeModelsHuman", () => {
  it("shows each alias with the id Claude Code reported, and the capabilities", () => {
    const defaults = getClaudeDefaults("2.1.322");
    const result: ClaudeModelsResult = {
      binary: { present: true, path: "claude", version: "2.1.322" },
      ...claudeModelList(reported([["", "claude-opus-5-5"], ["fable", "claude-fable-5-2"], ["quill", null]]), defaults),
      capabilities: defaults.capabilities,
      verifiedVersion: defaults.verifiedVersion,
    };
    const human = formatClaudeModelsHuman(result);
    expect(human).toContain("Claude Code: present (2.1.322)");
    expect(human).toContain("Models, as Claude Code reports them:");
    expect(human).toContain("  - Fable 5.2: claude-fable-5-2, 1M context (default) --model fable");
    expect(human).toContain("  - Opus 5.5: claude-opus-5-5, 1M context (default) [default] (no flag)");
    expect(human).toContain("Not listed: Claude Code does not resolve --model quill");
    expect(human).toContain("Auto-compact: yes (100k–1M)");
  });
  it("says so when Claude Code named none", () => {
    const defaults = getClaudeDefaults(null);
    const human = formatClaudeModelsHuman({ binary: { present: false, path: "/nope/claude", version: null },
      models: [], modelsDetail: "/nope/claude is not installed or not on PATH", capabilities: defaults.capabilities, verifiedVersion: defaults.verifiedVersion });
    expect(human).toContain("Models: none named by Claude Code.");
    expect(human).toContain("Not listed: /nope/claude is not installed or not on PATH");
  });
});
