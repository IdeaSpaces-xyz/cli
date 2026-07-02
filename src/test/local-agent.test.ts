import { describe, it, expect } from "vitest";
import { harvestWorkspace, deriveConversationName } from "../local-agent.js";
import type { ToolInvocation } from "@ideaspaces/sdk";

const inv = (name: string, args: Record<string, unknown>, isError = false): ToolInvocation => ({
  name,
  args,
  result: "ok",
  isError,
});

describe("harvestWorkspace (pi-is-space tool classification)", () => {
  it("maps is_write to modified and is_navigate/read to referenced", () => {
    const ws = harvestWorkspace([
      inv("is_write", { path: "notes/a.md" }),
      inv("is_navigate", { path: "notes" }),
      inv("read", { path: "notes/b.md" }),
    ]);
    expect(ws.modified).toEqual(["notes/a.md"]);
    expect(ws.read).toEqual(["notes", "notes/b.md"]);
    expect(ws.created).toEqual([]);
  });

  it("expands is_commit paths[] into modified", () => {
    const ws = harvestWorkspace([inv("is_commit", { paths: ["notes/a.md", "notes/c.md"] })]);
    expect(ws.modified).toEqual(["notes/a.md", "notes/c.md"]);
  });

  it("skips errored tool calls and dedupes", () => {
    const ws = harvestWorkspace([
      inv("is_write", { path: "notes/a.md" }),
      inv("is_write", { path: "notes/a.md" }), // dup
      inv("is_write", { path: "notes/bad.md" }, true), // errored
    ]);
    expect(ws.modified).toEqual(["notes/a.md"]);
  });

  it("ignores tools without a usable path and unknown tools", () => {
    const ws = harvestWorkspace([
      inv("is_status", {}),
      inv("is_write", { notpath: 1 }),
      inv("some_other_tool", { path: "x.md" }),
    ]);
    expect(ws).toEqual({ created: [], modified: [], deleted: [], read: [], mentioned: [] });
  });
});

describe("deriveConversationName (first-message naming)", () => {
  it("uses the first non-empty line, whitespace-collapsed", () => {
    expect(deriveConversationName("  Plan the   launch\nmore text")).toBe("Plan the launch");
    expect(deriveConversationName("\n\nSecond line is first real")).toBe("Second line is first real");
  });

  it("caps long names with an ellipsis", () => {
    const name = deriveConversationName("x".repeat(100));
    expect(name.length).toBe(58); // 57 + ellipsis
    expect(name.endsWith("…")).toBe(true);
  });

  it("falls back to Untitled on empty input", () => {
    expect(deriveConversationName("   \n  ")).toBe("Untitled");
  });
});
