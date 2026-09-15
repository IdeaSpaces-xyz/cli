import { describe, expect, it } from "vitest";
import { contractSourceFlag, preferredContractSource } from "../contract-source.js";

describe("CLI contract-source policy", () => {
  it("prefers Agreement, then Foundation, then floor", () => {
    expect(preferredContractSource(["foundation", "agreement"])).toBe("agreement");
    expect(preferredContractSource(["foundation"])).toBe("foundation");
    expect(preferredContractSource([])).toBeNull();
  });

  it("parses only explicit protocol frame names", () => {
    expect(contractSourceFlag(undefined)).toEqual({});
    expect(contractSourceFlag("agreement")).toEqual({ source: "agreement" });
    expect(contractSourceFlag("foundation")).toEqual({ source: "foundation" });
    expect(contractSourceFlag("both")).toEqual({
      error: "--contract must be `foundation` or `agreement`",
    });
  });
});
