import { describe, it, expect } from "vitest";
import { FOUNDATION_MD, gitignoreWithDefaults } from "../templates/default.js";
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

describe("gitignoreWithDefaults", () => {
  it("returns the defaults alone when there is no .gitignore — the fork case", () => {
    const merged = gitignoreWithDefaults(null, { privateAgent: false });
    expect(merged).not.toBeNull();
    expect(merged!.startsWith("\n")).toBe(false);
    expect(merged).toContain("*.local.md");
  });

  it("appends to an existing file without disturbing what is there", () => {
    const merged = gitignoreWithDefaults("node_modules/\n", { privateAgent: false });
    expect(merged).toContain("node_modules/");
    expect(merged).toContain("# ideaspace defaults");
  });

  it("separates appended defaults from a file with no trailing newline", () => {
    const merged = gitignoreWithDefaults("node_modules/", { privateAgent: false });
    expect(merged).toContain("node_modules/\n");
  });

  it("returns null when the defaults are already there — never a second copy", () => {
    const once = gitignoreWithDefaults(null, { privateAgent: false })!;
    expect(gitignoreWithDefaults(once, { privateAgent: false })).toBeNull();
  });
});
