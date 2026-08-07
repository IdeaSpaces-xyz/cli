import { describe, expect, it } from "vitest";
import { findCommand_ } from "../router.js";

describe("router", () => {
  it("does not expose the removed id command", () => {
    expect(findCommand_("id")).toBeUndefined();
  });

  it("exposes the explicit history-free fork command", () => {
    expect(findCommand_("fork")?.name).toBe("fork");
  });

  it("exposes local progressive Markdown inspection", () => {
    expect(findCommand_("inspect")?.name).toBe("inspect");
  });
});
