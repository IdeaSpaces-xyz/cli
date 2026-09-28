import { describe, expect, it } from "vitest";
import { findCommand_, printHelp } from "../router.js";

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

  it("exposes follow and unfollow as one subscription verb family", () => {
    expect(findCommand_("follow")?.name).toBe("follow");
    expect(findCommand_("unfollow")?.name).toBe("unfollow");
  });

  it("exposes the agent command for running or listing agents", () => {
    expect(findCommand_("agent")?.name).toBe("agent");
  });

  it("registers every command name uniquely in help output", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    };
    try {
      printHelp();
      const output = lines.join("");
      const commandNames = (output.match(/^ {2}([a-z-]+) {2,}/gm) ?? []).map((l) => l.trim().split(/\s+/)[0]);
      const duplicates = commandNames.filter((name, idx) => commandNames.indexOf(name) !== idx);
      expect(duplicates).toEqual([]);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
