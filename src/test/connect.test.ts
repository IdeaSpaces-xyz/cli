import { describe, expect, it } from "vitest";
import { normalizeConnectOrigin } from "../commands/power/connect.js";

describe("normalizeConnectOrigin", () => {
  it("keeps https origins unchanged", () => {
    expect(normalizeConnectOrigin("https://github.com/IdeaSpaces-xyz/ideaspace.git")).toBe(
      "https://github.com/IdeaSpaces-xyz/ideaspace.git",
    );
  });

  it("converts scp-like git origin to https", () => {
    expect(normalizeConnectOrigin("git@github.com:IdeaSpaces-xyz/ideaspace.git")).toBe(
      "https://github.com/IdeaSpaces-xyz/ideaspace.git",
    );
  });

  it("converts ssh origin to https", () => {
    expect(normalizeConnectOrigin("ssh://git@github.com/IdeaSpaces-xyz/ideaspace.git")).toBe(
      "https://github.com/IdeaSpaces-xyz/ideaspace.git",
    );
  });
});
