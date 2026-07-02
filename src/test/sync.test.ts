import { describe, it, expect } from "vitest";
import { syncCommand } from "../commands/sync.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

// `sync` is a tombstone now — split into `pull` + `push`. It should never do
// anything; it only points migrating callers at the two directional commands.
describe("ideaspaces sync (removed)", () => {
  it("always fails with migration guidance, no repo needed", async () => {
    const exit = await syncCommand.run([], {}, G);
    expect(exit).toBe(1);
  });
});
