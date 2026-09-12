import { describe, expect, it } from "vitest";
import { preferredContractSource } from "../contract-source.js";

describe("CLI contract-source policy", () => {
  it("prefers Agreement, then Foundation, then floor", () => {
    expect(preferredContractSource(["foundation", "agreement"])).toBe("agreement");
    expect(preferredContractSource(["foundation"])).toBe("foundation");
    expect(preferredContractSource([])).toBeNull();
  });
});
