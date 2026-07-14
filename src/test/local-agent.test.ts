import { describe, it, expect } from "vitest";
import { harvestWorkspace, deriveConversationName, buildPiArgs } from "../pi/local-agent.js";
import type { ToolInvocation } from "@ideaspaces/sdk";
import type { LocalTurnOptions } from "../pi/local-agent.js";

const baseOpts: LocalTurnOptions = {
  repoPath: "/ws",
  message: "hi",
  extensionPaths: ["/ext/pi-is-space", "/ext/pi-local-context"],
  conversationId: "local-abc",
  sessionDir: "/ws/.pi/sessions",
};

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

describe("buildPiArgs (pi rpc argv)", () => {
  const pairs = (args: string[], flag: string): string[] =>
    args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

  it("forwards each extension as a --extension pair", () => {
    const args = buildPiArgs(baseOpts);
    expect(pairs(args, "--extension")).toEqual(["/ext/pi-is-space", "/ext/pi-local-context"]);
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
  });

  it("adds --no-extensions so explicit extensions are authoritative (no global double-load)", () => {
    expect(buildPiArgs(baseOpts)).toContain("--no-extensions");
  });

  it("omits --no-extensions when no extensions are passed (would otherwise load none)", () => {
    expect(buildPiArgs({ ...baseOpts, extensionPaths: [] })).not.toContain("--no-extensions");
  });

  it("forwards each skill dir as a --skill pair", () => {
    const args = buildPiArgs({ ...baseOpts, skillPaths: ["/ext/pi-is-space/skills", "/ext/pi-local-context/skills"] });
    expect(pairs(args, "--skill")).toEqual(["/ext/pi-is-space/skills", "/ext/pi-local-context/skills"]);
  });

  it("emits no --skill when skillPaths is absent (dev: pi-install'ed)", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("--skill");
  });

  it("adds --model only when piModel is set", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("--model");
    expect(buildPiArgs({ ...baseOpts, piModel: "sonnet" })).toEqual(
      expect.arrayContaining(["--model", "sonnet"]),
    );
  });
});
