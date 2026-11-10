import { describe, expect, it } from "vitest";
import { commandHelp, findCommand_, printHelp } from "../router.js";

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
    expect(findCommand_("inbox")).toBeUndefined();
  });

  it("resolves retired follow and unfollow for compatibility refusals", () => {
    expect(findCommand_("follow")?.name).toBe("follow");
    expect(findCommand_("unfollow")?.name).toBe("unfollow");
  });

  it("exposes the agent command for running or listing agents", () => {
    expect(findCommand_("agent")?.name).toBe("agent");
  });

  it("registers every command name uniquely in help output", () => {
    const lines: string[] = [];
    const origWrite = process.stdout.write;
    (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
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
      process.stdout.write = origWrite;
    }
  });

  it("prints verb-specific help and refuses invented verbs", () => {
    const threads = findCommand_("threads")!;
    expect(commandHelp(threads, ["open"])).toContain("Usage: ideaspaces threads open <slug|path>");
    expect(commandHelp(threads, ["open"])).not.toContain("ideaspaces threads post <slug|path>");
    expect(commandHelp(threads, ["imaginary"])).toBeUndefined();
    expect(commandHelp(findCommand_("agent")!, ["run"])).toContain("Usage: ideaspaces agent run");
    expect(commandHelp(findCommand_("spaces")!, ["import"])).toContain("Usage: ideaspaces spaces import");
    expect(commandHelp(findCommand_("map")!, ["home.map.md"])).toContain("Usage: ideaspaces map [<folder|map-note>]");
    expect(commandHelp(findCommand_("look")!, ["notes/a.md"])).toContain("Usage: ideaspaces look");
  });
});
