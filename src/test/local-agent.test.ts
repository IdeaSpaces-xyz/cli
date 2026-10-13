import { Readable } from "node:stream";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  });

  it("defaults trust to saved (no -a unasked) and passes -a only on explicit trust", () => {
    expect(buildPiArgs(baseOpts)).not.toContain("-a");
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

describe("runLocalTurn — Pi's provider retry", () => {
  it("reproduces and then waits through intermediate agent_end, retaining the last tool step", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-retry-"));
    try {
      const script = join(tmp, "pi.cjs");
      writeFileSync(script, `
process.stdin.on("data", (input) => {
  if (!String(input).includes('"type":"prompt"')) return;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "response", command: "get_state", success: true, data: { sessionName: "Already named" } });
  emit({ type: "response", command: "prompt", success: true });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "checkpoint.md" } });
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "checkpoint" }] }, isError: false });
  emit({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }] });
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0 });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Resumed after fetch failed" } });
  emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop", usage: { input: 12, output: 4, totalTokens: 16, cost: { total: 0.002 } } }] });
});
`);
      const bin = join(tmp, "pi");
      writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(bin, 0o755);
      const events = [];
      for await (const event of runLocalTurn({ ...baseOpts, repoPath: tmp, sessionDir: join(tmp, ".pi", "sessions"), piBin: bin })) events.push(event);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
      expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "turn_complete", result: { response: "Resumed after fetch failed", tool_calls: [{ name: "read", args: { path: "checkpoint.md" } }], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, cost_usd: 0.002 } } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runLocalTurn — exhausted and interrupted provider attempts", () => {
  async function fakeRun(events: object[], exitAfter = false) {
    const tmp = mkdtempSync(join(tmpdir(), "pi-terminal-"));
    try {
      const script = join(tmp, "pi.cjs");
      writeFileSync(script, `
process.stdin.on("data", (input) => {
  if (!String(input).includes('"type":"prompt"')) return;
  for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");
  ${exitAfter ? "setTimeout(() => process.exit(7), 20);" : ""}
});
`);
      const bin = join(tmp, "pi");
      writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(bin, 0o755);
      const emitted = [];
      for await (const event of runLocalTurn({ ...baseOpts, repoPath: tmp, sessionDir: join(tmp, ".pi", "sessions"), piBin: bin })) emitted.push(event);
      return emitted;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("preserves the pi_error type for a final 429 provider refusal", async () => {
    const events = await fakeRun([
      { type: "agent_start" },
      { type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "RESOURCE_EXHAUSTED (429)" }] },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "error", error_type: "pi_error", message: "RESOURCE_EXHAUSTED (429)" });
    expect(events.some((event) => event.type === "turn_complete")).toBe(false);
  });

  it("reports the cause and resume id when Pi exits during its retry", async () => {
    const events = await fakeRun([
      { type: "agent_start" },
      { type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }] },
    ], true);
    expect(events.at(-1)).toMatchObject({ type: "error", error_type: "pi_exit", message: expect.stringContaining("fetch failed") });
    expect((events.at(-1) as { message: string }).message).toContain("local-abc");
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
