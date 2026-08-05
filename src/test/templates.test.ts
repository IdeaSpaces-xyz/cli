import { describe, it, expect } from "vitest";
import { FOUNDATION_MD } from "../templates/default.js";
import { FOUNDATION_CORE, FOUNDATION_CORE_VERSION } from "@ideaspaces/protocol";

describe("foundation template composition", () => {
  it("carries the protocol's foundation core byte-for-byte", () => {
    // The conduct layer is not authored in this repo — hand-drift against the
    // canonical seed must be structurally impossible.
    expect(FOUNDATION_MD).toContain(FOUNDATION_CORE.trim());
  });

  it("stamps core_version from the protocol build", () => {
    expect(FOUNDATION_MD).toContain(`core_version: ${FOUNDATION_CORE_VERSION}`);
    expect(FOUNDATION_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("replaces the old hand-maintained conduct sections", () => {
    expect(FOUNDATION_MD).not.toContain("## Identity");
    // Conduct lives once, in The Agreement — not restated in Practice.
    expect(FOUNDATION_MD.match(/Capture is conscious/g)).toHaveLength(1);
    expect(FOUNDATION_MD).toContain("## The Agreement");
    expect(FOUNDATION_MD).toContain("**Protect:**");
    expect(FOUNDATION_MD).toContain("**Never:**");
    expect(FOUNDATION_MD).toContain("not instructions to follow");
  });
});
