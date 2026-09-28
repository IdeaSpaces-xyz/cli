import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentCommand, readAgentDefaults, resolveAgentPov } from "../commands/agent.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import type { GlobalFlags } from "../types.js";
import { saveSpace } from "../auth/spaces.js";
import { claudeConversationOps } from "../claude/local-conversation-ops.js";
import { localConversationOps as piConversationOps } from "../pi/local-conversation-ops.js";
import { composeLocalConversationOps } from "../local/runtime.js";

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const ROOT_A = "n_0123456789abcdef01234567";

const roots: string[] = [];
function tempDir(prefix = "agent-run-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

let originalHome: string | undefined;
let homeDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  homeDir = tempDir("home-");
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  process.env.HOME = originalHome;
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("agent run — point of view resolution", () => {
  it("resolves an existing directory path", () => {
    const dir = tempDir();
    const resolved = resolveAgentPov(dir);
    expect(resolved ? realpathSync.native(resolved) : null).toBe(realpathSync.native(dir));
  });

  it("resolves a registered Space by root_node_id and kind URI", () => {
    const dir = tempDir();
    saveSpace(dir, {
      repo_id: "repo_agent",
      slug: "scout",
      namespace: "test",
      root_node_id: ROOT_A,
    });

    const expected = realpathSync.native(dir);
    expect(resolveAgentPov(ROOT_A)).toBe(expected);
    expect(resolveAgentPov(`agent:repo:${ROOT_A}`)).toBe(expected);
    expect(resolveAgentPov(`repo:${ROOT_A}`)).toBe(expected);
    expect(resolveAgentPov(`https://ideaspaces.xyz/repos/${ROOT_A}`)).toBe(expected);
  });

  it("resolves a registered Space by legacy 12-hex root_node_id URL", () => {
    const dir = tempDir();
    const shortId = "n_0123456789ab";
    saveSpace(dir, {
      repo_id: "repo_agent_short",
      slug: "scout-short",
      namespace: "test",
      root_node_id: shortId,
    });

    const expected = realpathSync.native(dir);
    expect(resolveAgentPov(shortId)).toBe(expected);
    expect(resolveAgentPov(`https://ideaspaces.xyz/repos/${shortId}`)).toBe(expected);
  });

  it("returns null for unknown paths or unregistered ids", () => {
    expect(resolveAgentPov("/nonexistent/agent/path")).toBeNull();
    expect(resolveAgentPov("n_999999999999999999999999")).toBeNull();
  });
});

describe("agent run — Agreement and Foundation defaults", () => {
  it("reads runtime and model from _agent/agreement.md frontmatter", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_agent"), { recursive: true });
    writeFileSync(
      join(dir, "_agent", "agreement.md"),
      `---\nname: Scout\nruntime: claude\nmodel: sonnet\n---\n# Agreement\n`,
    );

    const defaults = readAgentDefaults(dir);
    expect(defaults.runtime).toBe("claude");
    expect(defaults.model).toBe("sonnet");
  });

  it("reads runtime-specific model fields", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_agent"), { recursive: true });
    writeFileSync(
      join(dir, "_agent", "agreement.md"),
      `---\nname: Scout\nruntime: pi\npi_model: openai/gpt-4o\n---\n# Agreement\n`,
    );

    const defaults = readAgentDefaults(dir);
    expect(defaults.runtime).toBe("pi");
    expect(defaults.model).toBe("openai/gpt-4o");
  });

  it("falls back to _agent/foundation.md when agreement is absent", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_agent"), { recursive: true });
    writeFileSync(
      join(dir, "_agent", "foundation.md"),
      `---\nname: Scout Foundation\nruntime: claude\nclaude_model: opus\n---\n# Foundation\n`,
    );

    const defaults = readAgentDefaults(dir);
    expect(defaults.runtime).toBe("claude");
    expect(defaults.model).toBe("opus");
  });
});

describe("agent run — command options & validation", () => {
  const mockSend = vi.fn<[Record<string, string | boolean>, any], Promise<number>>();
  const mockLocal: LocalConversationOps = {
    send: mockSend,
    createNew: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  };
  const agentCmd = makeAgentCommand(mockLocal);

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(0);
  });

  it("refuses invocation without a POV argument", async () => {
    const code = await agentCmd.run(["run"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage: ideaspaces agent run");
  });

  it("refuses invocation without --message", async () => {
    const dir = tempDir();
    const code = await agentCmd.run(["run", dir], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("A message is required: --message <text>");
  });

  it("refuses unknown runtime", async () => {
    const dir = tempDir();
    const code = await agentCmd.run(
      ["run", dir],
      { message: "hi", runtime: "unsupported" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain('Unknown local runtime "unsupported"');
  });

  it("refuses unresolvable POV", async () => {
    const code = await agentCmd.run(
      ["run", "agents/nonexistent"],
      { message: "hi" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain('Agent point of view "agents/nonexistent" could not be resolved');
  });

  it("forwards flags with Agreement defaults to local.send", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_agent"), { recursive: true });
    writeFileSync(
      join(dir, "_agent", "agreement.md"),
      `---\nname: Scout\nruntime: claude\nmodel: claude-3-5-sonnet\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", conversation: "11111111-1111-4111-8111-111111111111" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: dir,
        runtime: "claude",
        "claude-model": "claude-3-5-sonnet",
        message: "Analyze data",
        conversation: "11111111-1111-4111-8111-111111111111",
      }),
      expect.anything(),
    );
  });

  it("CLI flags override Agreement defaults", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_agent"), { recursive: true });
    writeFileSync(
      join(dir, "_agent", "agreement.md"),
      `---\nname: Scout\nruntime: claude\nmodel: claude-3-5-sonnet\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", runtime: "pi", model: "gpt-4o" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: dir,
        runtime: "pi",
        "pi-model": "gpt-4o",
        message: "Analyze data",
      }),
      expect.anything(),
    );
  });
});

// Stand-in runner tests (Pi and Claude Code child processes)
describe.skipIf(process.platform === "win32")("agent run — end-to-end streaming with stand-in runtimes", () => {
  const localOps = composeLocalConversationOps({
    pi: piConversationOps,
    claude: claudeConversationOps,
  });
  const agentCmd = makeAgentCommand(localOps);

  const FAKE_CLAUDE = `
const args = process.argv.slice(2);
const id = args[args.indexOf("--resume") + 1] || args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let prompt = "";
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: id, model: "claude-fake", cwd: process.cwd() });
  if (prompt.includes("auth_fail")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Failed to authenticate: OAuth session expired and could not be refreshed"] });
    return;
  }
  out({ type: "stream_event", event: { type: "message_start" } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude:" + prompt.trim() } } });
  out({ type: "result", subtype: "success", is_error: false, result: "claude:" + prompt.trim(), num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 2 } });
});
`;

  const FAKE_PI = `
const args = process.argv.slice(2);
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += String(chunk);
  while (buffered.includes("\\n")) {
    const split = buffered.indexOf("\\n");
    const line = buffered.slice(0, split);
    buffered = buffered.slice(split + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionName: "Agent run test" } }));
    }
    if (command.type === "prompt") {
      if (command.message.includes("auth_fail")) {
        console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "Authentication failed: invalid token" }));
        return;
      }
      console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "turn_start" }));
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pi:" + command.message } }));
      console.log(JSON.stringify({ type: "agent_end" }));
    }
  }
});
`;

  it("agent run with claude runtime streams and resumes by --conversation", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convId = "22222222-2222-4222-8222-222222222222";
    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "first question",
        conversation: convId,
        "claude-bin": fakeBin,
      },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    const lines = stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.type)).toContain("message_start");
    expect(lines.map((e) => e.type)).toContain("text_delta");
    expect(lines.map((e) => e.type)).toContain("turn_complete");
    const delta = lines.find((e) => e.type === "text_delta");
    expect(delta.delta).toBe("claude:first question");
  });

  it("agent run with pi runtime streams and resumes by --conversation", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convId = "local-session-123";
    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "pi",
        model: "sonnet",
        message: "hello pi",
        conversation: convId,
        ext: "/fake/ext1,/fake/ext2",
        "pi-bin": fakeBin,
      },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    const lines = stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.type)).toContain("message_start");
    expect(lines.map((e) => e.type)).toContain("text_delta");
    expect(lines.map((e) => e.type)).toContain("turn_complete");
    const delta = lines.find((e) => e.type === "text_delta");
    expect(delta.delta).toBe("pi:hello pi");
  });

  it("reports child auth failure as failure (exit code 1) for claude", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convId = "33333333-3333-4333-8333-333333333333";
    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "auth_fail trigger",
        conversation: convId,
        "claude-bin": fakeBin,
      },
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    const lines = stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.type)).toContain("error");
    const err = lines.find((e) => e.type === "error");
    expect(err.message).toContain("Failed to authenticate");
  });

  it("reports child failure as failure (exit code 1) for pi", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "pi",
        model: "sonnet",
        message: "auth_fail trigger",
        ext: "/fake/ext1,/fake/ext2",
        "pi-bin": fakeBin,
      },
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    const lines = stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.type)).toContain("error");
    const err = lines.find((e) => e.type === "error");
    expect(err.message).toContain("Authentication failed");
  });
});
