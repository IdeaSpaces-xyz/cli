import { describe, expect, it } from "vitest";
import { claudeRecordModel } from "../claude/local-agent.js";
import { piStateModel, reportedModel } from "../local/send-options.js";

describe("launch model report", () => {
  it("reads Pi's resolved model from get_state, and null when Pi names none", () => {
    expect(piStateModel({ model: { provider: "anthropic", id: "claude-x" } })).toBe("anthropic/claude-x");
    expect(piStateModel({ model: { id: "bare" } })).toBe("bare");
    expect(piStateModel({ sessionName: "no model" })).toBeNull();
    expect(piStateModel(undefined)).toBeNull();
    expect(piStateModel({ model: { provider: "p", id: "" } })).toBeNull();
  });

  it("reads Claude's model from init or an assistant message only", () => {
    expect(claudeRecordModel({ type: "system", subtype: "init", model: "claude-opus-x" })).toBe("claude-opus-x");
    expect(claudeRecordModel({ type: "assistant", message: { model: "claude-sonnet-x" } })).toBe("claude-sonnet-x");
    expect(claudeRecordModel({ type: "system", subtype: "compact_boundary", model: "ignored" })).toBeNull();
    expect(claudeRecordModel({ type: "result" })).toBeNull();
  });

  it("refuses control characters and unbounded strings as a reported model", () => {
    expect(reportedModel("ok-model")).toBe("ok-model");
    expect(reportedModel("evil\u001b[2Jmodel")).toBeNull();
    expect(reportedModel("x".repeat(201))).toBeNull();
    expect(reportedModel("  ")).toBeNull();
    expect(reportedModel(42)).toBeNull();
  });
});
