import { describe, it, expect } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  isValidClaudeAuthMode,
  isValidClaudePermissionMode,
  type ClaudeTurnOptions,
} from "../claude/local-agent.js";
import { claudeToolBaseName, normalizeClaudeInvocation } from "../claude/tool-names.js";
import type { ToolInvocation } from "@ideaspaces/sdk";

const base: ClaudeTurnOptions & { sessionExists: boolean } = {
  repoPath: "/ws",
  message: "hi",
  conversationId: "d0b2e296-c2b7-4fa4-8227-6390639ea756",
  sessionExists: true,
};

describe("buildClaudeArgs", () => {
  it("runs headless stream-json with partial messages, verbose, and acceptEdits by default", () => {
    expect(buildClaudeArgs(base)).toEqual([
      "-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages",
      "--permission-mode", "acceptEdits",
      "--resume", base.conversationId,
    ]);
  });

  it("creates the session with --session-id when it does not exist yet", () => {
    expect(buildClaudeArgs({ ...base, sessionExists: false })).toContain("--session-id");
    expect(buildClaudeArgs({ ...base, sessionExists: false })).not.toContain("--resume");
  });

  it("allows a distinct working root through --add-dir, and skips it when it is the POV", () => {
    expect(buildClaudeArgs({ ...base, workingRoot: "/work" })).toContain("--add-dir");
    expect(buildClaudeArgs({ ...base, workingRoot: "/ws" })).not.toContain("--add-dir");
  });

  it("passes model, permission mode, and orientation through", () => {
    const args = buildClaudeArgs({ ...base, model: "sonnet", permissionMode: "plan", mapOrientation: "MAP", launchOrientation: "LAUNCH" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("MAP\n\nLAUNCH");
  });

  it("never carries the prompt — it rides stdin", () => {
    expect(buildClaudeArgs({ ...base, message: "a very long message" })).not.toContain("a very long message");
  });
});

describe("buildClaudeEnv", () => {
  const ambient = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_AUTH_TOKEN: "tok", HOME: "/h" };

  it("scrubs API-key routing on the login path so usage bills to the user's plan", () => {
    expect(buildClaudeEnv("login", ambient)).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("lets the key through when api-key auth is asked for", () => {
    expect(buildClaudeEnv("api-key", ambient)).toEqual(ambient);
  });

  it("leaves the user's own provider routing alone — it is configuration, not an ambient key", () => {
    const bedrock = { ...ambient, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work" };
    expect(buildClaudeEnv("login", bedrock)).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work" });
  });
});

describe("validators", () => {
  it("accept Claude Code's permission modes and our auth modes only", () => {
    expect(isValidClaudePermissionMode("acceptEdits")).toBe(true);
    expect(isValidClaudePermissionMode("bypassPermissions")).toBe(true);
    expect(isValidClaudePermissionMode("yolo")).toBe(false);
    expect(isValidClaudeAuthMode("login")).toBe(true);
    expect(isValidClaudeAuthMode("api-key")).toBe(true);
    expect(isValidClaudeAuthMode("oauth")).toBe(false);
  });
});

describe("Claude tool names for the workspace harvest", () => {
  it("strips the MCP server prefix", () => {
    expect(claudeToolBaseName("mcp__plugin_ideaspaces_core__is_write")).toBe("is_write");
    expect(claudeToolBaseName("Write")).toBe("Write");
  });

  it("rewrites native file tools into the pi-shaped write/edit/read with `path`", () => {
    const inv = (name: string, args: Record<string, unknown>): ToolInvocation => ({ name, args, result: null, isError: false });
    expect(normalizeClaudeInvocation(inv("Write", { file_path: "/s/a.md", content: "x" }))).toMatchObject({ name: "write", args: { path: "/s/a.md" } });
    expect(normalizeClaudeInvocation(inv("Edit", { file_path: "/s/a.md" }))).toMatchObject({ name: "edit", args: { path: "/s/a.md" } });
    expect(normalizeClaudeInvocation(inv("MultiEdit", { file_path: "/s/a.md" }))).toMatchObject({ name: "edit" });
    expect(normalizeClaudeInvocation(inv("NotebookEdit", { notebook_path: "/s/n.ipynb" }))).toMatchObject({ name: "edit", args: { path: "/s/n.ipynb" } });
    expect(normalizeClaudeInvocation(inv("Read", { file_path: "/s/a.md" }))).toMatchObject({ name: "read", args: { path: "/s/a.md" } });
    expect(normalizeClaudeInvocation(inv("mcp__plugin_ideaspaces_core__is_write", { path: "n.md" }))).toMatchObject({ name: "is_write", args: { path: "n.md" } });
    const bash = inv("Bash", { command: "ls" });
    expect(normalizeClaudeInvocation(bash)).toBe(bash);
  });
});
