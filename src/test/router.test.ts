import { describe, expect, it } from "vitest";
import { findCommand_ } from "../router.js";

describe("router", () => {
  it("does not expose the removed id command", () => {
    expect(findCommand_("id")).toBeUndefined();
  });
});
