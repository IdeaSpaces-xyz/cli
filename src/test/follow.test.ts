import { afterEach, describe, expect, it, vi } from "vitest";
import { followCommand, unfollowCommand } from "../commands/follow.js";
import { findCommand_, printHelp } from "../router.js";
import * as api from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const loadConfig = vi.hoisted(() => vi.fn(() => { throw new Error("must not read credentials"); }));
vi.mock("../auth/credentials.js", async (original) => ({
  ...await original<typeof import("../auth/credentials.js")>(), loadConfig,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); loadConfig.mockClear(); });

describe("retired subscription commands", () => {
  it.each([false, true])("refuses every old form before auth/network, json=%s", async json => {
    const fetch = vi.fn(() => { throw new Error("must not request"); });
    vi.stubGlobal("fetch", fetch);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const global: GlobalFlags = { json, quiet: false, yes: false, help: false };
    for (const command of [followCommand, unfollowCommand]) {
      expect(findCommand_(command.name)).toBe(command);
      for (const args of [[], ["thread", "x_" + "a".repeat(24)], ["node", "n_" + "a".repeat(24)], ["repo", "n_" + "a".repeat(24)]]) {
        for (const flags of [{}, { ack: "42" }]) {
          out.mockClear(); err.mockClear();
          expect(await command.run(args, flags, global)).toBe(1);
          const text = [...out.mock.calls, ...err.mock.calls].map(c => c[0]).join("");
          expect(text).toContain("retired"); expect(text).toContain("No request was sent");
          expect(text).toContain("threads list --unread");
        }
      }
    }
    expect(loadConfig).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("neither advertises follow commands nor exports subscription API helpers", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    printHelp();
    const help = err.mock.calls.map(c => c[0]).join("");
    expect(help).not.toMatch(/\n  (?:un)?follow\s/);
    for (const name of ["listSubscriptions", "putSubscription", "deleteSubscription", "acknowledgeSubscription"]) expect(api).not.toHaveProperty(name);
  });
});
