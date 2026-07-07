import { describe, expect, it } from "vitest";
import { parseTrailers } from "@ideaspaces/sdk";
import { applyTrailerFlags } from "../commands/commit.js";

describe("applyTrailerFlags", () => {
  it("returns the message unchanged when no trailer flag is set", () => {
    expect(applyTrailerFlags("Save notes", {})).toBe("Save notes");
    // Non-trailer flags (e.g. --all, -m) never add a trailer block.
    expect(applyTrailerFlags("Save notes", { all: true, m: "Save notes" })).toBe("Save notes");
  });

  it("stamps op, change-id, conversation, and co-authors", () => {
    const out = applyTrailerFlags("Capture auth decision", {
      op: "capture",
      "change-id": "chg_auth-1a2b",
      conversation: "sess_9",
      "co-author": "agent:me-claude",
    });
    const t = parseTrailers(out);
    expect(t.op).toBe("capture");
    expect(t.changeId).toBe("chg_auth-1a2b");
    expect(t.conversation).toBe("sess_9");
    expect(t.coAuthoredBy).toEqual(["agent:me-claude"]);
  });

  it("splits a comma-separated --co-author into multiple values", () => {
    const out = applyTrailerFlags("msg", { "co-author": "agent:a, agent:b ,agent:c" });
    expect(parseTrailers(out).coAuthoredBy).toEqual(["agent:a", "agent:b", "agent:c"]);
  });

  it("rejects an invalid change-id", () => {
    expect(() => applyTrailerFlags("msg", { "change-id": "NOTVALID" })).toThrow(/change-id/);
  });

  it("rejects an unknown op", () => {
    expect(() => applyTrailerFlags("msg", { op: "frobnicate" })).toThrow(/Invalid --op/);
  });

  it("rejects a co-author without a person:/agent:/node: prefix", () => {
    expect(() => applyTrailerFlags("msg", { "co-author": "me-claude" })).toThrow(/Invalid --co-author/);
    // One bad value in a list fails the whole commit — trailers are permanent.
    expect(() => applyTrailerFlags("msg", { "co-author": "agent:ok, bare" })).toThrow(/Invalid --co-author/);
  });

  it("ignores empty-string trailer flags", () => {
    expect(applyTrailerFlags("msg", { op: "", "change-id": "", conversation: "", "co-author": "" })).toBe("msg");
  });
});
