import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  deriveConversationName,
  buildPiArgs,
  isValidPiThinkingLevel,
  readRpcLines,
  runLocalTurn,
} from "../pi/local-agent.js";
import type { LocalTurnOptions } from "../pi/local-agent.js";

const baseOpts: LocalTurnOptions = {
  repoPath: "/ws",
  message: "hi",
  extensionPaths: ["/ext/pi-is-space", "/ext/pi-local-context"],
  conversationId: "local-abc",
  sessionDir: "/ws/.pi/sessions",
};

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

describe("readRpcLines (strict Pi RPC framing)", () => {
  it("splits only on LF and preserves Unicode line separators inside JSON", async () => {
    const input = Readable.from([
      Buffer.from('{"text":"before'),
      Buffer.from("\u2028after"),
      Buffer.from('"}\r\n{"second":true}\n'),
    ]);
    const lines: string[] = [];
    for await (const line of readRpcLines(input)) lines.push(line);

    expect(lines).toEqual(['{"text":"before\u2028after"}', '{"second":true}']);
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
    expect(buildPiArgs({ ...baseOpts, trust: "saved" })).not.toContain("-a");
    expect(buildPiArgs({ ...baseOpts, trust: "explicit" })).toContain("-a");
  });

  it("omits --no-extensions when no extensions are passed (would otherwise load none)", () => {
    expect(buildPiArgs({ ...baseOpts, extensionPaths: [] })).not.toContain("--no-extensions");
  });

  it("forwards each skill dir as a --skill pair", () => {
    const args = buildPiArgs({ ...baseOpts, skillPaths: ["/ext/pi-is-space/skills", "/ext/pi-local-context/skills"] });
    expect(pairs(args, "--skill")).toEqual(["/ext/pi-is-space/skills", "/ext/pi-local-context/skills"]);
  });

  it("agent child skill selection suppresses discovery but keeps explicitly forwarded dirs", () => {
    const args = buildPiArgs({ ...baseOpts, disableSkillDiscovery: true, skillPaths: ["/trusted/skill"] });
    expect(args).toContain("--no-skills");
    expect(pairs(args, "--skill")).toEqual(["/trusted/skill"]);
    expect(buildPiArgs({ ...baseOpts, disableSkillDiscovery: true, skillPaths: [] })).toContain("--no-skills");
  });

  it("direct conversation send retains Pi skill discovery unless selected by agent run", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("--skill");
    expect(buildPiArgs(baseOpts)).not.toContain("--no-skills");
  });

  it("appends Map orientation only when a map-note was selected", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("--append-system-prompt");
    expect(buildPiArgs({ ...baseOpts, mapOrientation: "[IdeaSpaces Map]\nMembers (0, ordered):" })).toEqual(
      expect.arrayContaining(["--append-system-prompt", "[IdeaSpaces Map]\nMembers (0, ordered):"]),
    );
  });

  it("adds --model only when piModel is set", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("--model");
    expect(buildPiArgs({ ...baseOpts, piModel: "sonnet" })).toEqual(
      expect.arrayContaining(["--model", "sonnet"]),
    );
  });

  it("adds --thinking only when thinkingLevel is set", () => {
    // Absent → no flag, so pi keeps the model/session default (not forced off).
    expect(buildPiArgs(baseOpts)).not.toContain("--thinking");
    expect(buildPiArgs({ ...baseOpts, thinkingLevel: "high" })).toEqual(
      expect.arrayContaining(["--thinking", "high"]),
    );
  });
});

describe("isValidPiThinkingLevel (pi thinking-level guard)", () => {
  it("accepts every level pi's args.ts defines, including off", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isValidPiThinkingLevel(level)).toBe(true);
    }
  });

  it("rejects unknown or malformed levels", () => {
    expect(isValidPiThinkingLevel("HIGH")).toBe(false); // case-sensitive
    expect(isValidPiThinkingLevel("ultra")).toBe(false);
    expect(isValidPiThinkingLevel("")).toBe(false);
  });
});

describe("runLocalTurn — missing binary error handling", () => {
  it("reports a binary that cannot start as an error event", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-missing-"));
    try {
      const events = [];
      for await (const e of runLocalTurn({
        ...baseOpts,
        repoPath: tmp,
        sessionDir: join(tmp, ".pi", "sessions"),
        piBin: "/nonexistent/path/to/pi",
      })) {
        events.push(e);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error_type: "pi_exit" });
      expect((events[0] as { message: string }).message).toMatch(/Could not start .*\/nonexistent\/path\/to\/pi/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
