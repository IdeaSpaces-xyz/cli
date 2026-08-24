import { describe, expect, it } from "vitest";
import { parseTrailerFlags } from "../commands/commit.js";

describe("parseTrailerFlags", () => {
  it("returns an empty structured request when no trailer flag is set", () => {
    expect(parseTrailerFlags({})).toEqual({});
    expect(parseTrailerFlags({ all: true, m: "Save notes" })).toEqual({});
  });

  it("translates op, change-id, conversation, and a legacy agent principal", () => {
    expect(
      parseTrailerFlags({
        op: "capture",
        "change-id": "chg_auth-1a2b",
        conversation: "sess_9",
        "co-author": "agent:me-claude",
      }),
    ).toEqual({
      op: "capture",
      change_id: "chg_auth-1a2b",
      conversation: "sess_9",
      co_authored_by: ["me-claude <agent:me-claude@ideaspaces>"],
    });
  });

  it("splits legacy co-authors and upgrades each deterministically", () => {
    expect(parseTrailerFlags({ "co-author": "agent:a, agent:b,agent:c" }).co_authored_by).toEqual([
      "a <agent:a@ideaspaces>",
      "b <agent:b@ideaspaces>",
      "c <agent:c@ideaspaces>",
    ]);
  });

  it("accepts the canonical protocol co-author spelling", () => {
    expect(
      parseTrailerFlags({ "co-author": "Keeper <agent:keeper@ideaspaces>" }).co_authored_by,
    ).toEqual(["Keeper <agent:keeper@ideaspaces>"]);
  });

  it("upgrades the platform principal spelling without doubling its domain", () => {
    expect(
      parseTrailerFlags({ "co-author": "agent:keeper@ideaspaces" }).co_authored_by,
    ).toEqual(["keeper <agent:keeper@ideaspaces>"]);
  });

  it("rejects an invalid change-id", () => {
    expect(() => parseTrailerFlags({ "change-id": "NOTVALID" })).toThrow(/change-id/);
  });

  it("rejects an unknown op", () => {
    expect(() => parseTrailerFlags({ op: "frobnicate" })).toThrow(/Invalid --op/);
  });

  it("rejects non-agent and malformed co-authors", () => {
    expect(() => parseTrailerFlags({ "co-author": "me-claude" })).toThrow(/Invalid --co-author/);
    expect(() => parseTrailerFlags({ "co-author": "person:alice" })).toThrow(/Invalid --co-author/);
    expect(() => parseTrailerFlags({ "co-author": "agent:ok, bare" })).toThrow(/Invalid --co-author/);
  });

  it("ignores empty-string trailer flags", () => {
    expect(
      parseTrailerFlags({ op: "", "change-id": "", conversation: "", "co-author": "" }),
    ).toEqual({});
  });
});
