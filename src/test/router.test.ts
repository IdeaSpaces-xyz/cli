import { describe, expect, it } from "vitest";
import { findCommand_ } from "../router.js";

describe("router", () => {
  it("exposes the local readiness doctor", () => {
    expect(findCommand_("doctor")?.name).toBe("doctor");
  });

  it("does not expose the removed id command", () => {
    expect(findCommand_("id")).toBeUndefined();
  });

  it("exposes the explicit history-free fork command", () => {
    expect(findCommand_("fork")?.name).toBe("fork");
  });

  it("exposes the rung-selective local look command", () => {
    expect(findCommand_("look")?.name).toBe("look");
  });

  it("keeps the derived local Map compatibility command", () => {
    expect(findCommand_("map")?.name).toBe("map");
  });

  it("exposes local progressive Markdown inspection", () => {
    expect(findCommand_("inspect")?.name).toBe("inspect");
  });

  it("exposes direct Inbox exchanges", () => {
    expect(findCommand_("inbox")?.name).toBe("inbox");
  });
});
