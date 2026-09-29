import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { appendPost, createThread, initWorktree, loadThread } from "../local/threads.js";
import { prepareThreadLaunch } from "../local/thread-launch.js";
import { threadsCommand } from "../commands/threads.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentCommand, readAgentDefaults, resolveAgentPov, revalidateAgentPov, validateAgentPov } from "../commands/agent.js";
import { makeConversationCommand, type LocalConversationOps } from "../commands/conversation.js";
import type { GlobalFlags } from "../types.js";
import { saveSpace } from "../auth/spaces.js";
import { claudeConversationOps } from "../claude/local-conversation-ops.js";
import { localConversationOps as piConversationOps } from "../pi/local-conversation-ops.js";
import { composeLocalConversationOps } from "../local/runtime.js";
import { claudeProjectDir } from "../claude/local-conversations.js";

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const ROOT_A = "n_0123456789abcdef01234567";

const roots: string[] = [];
function tempDir(prefix = "agent-run-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function makeAgentDir(prefix = "agent-run-test-", content = "# Agreement\n"): string {
  const dir = tempDir(prefix);
  mkdirSync(join(dir, "_agent"), { recursive: true });
  writeFileSync(join(dir, "_agent", "agreement.md"), content);
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
  it("resolves an existing directory path carrying an Agreement", () => {
    const dir = makeAgentDir();
    const resolved = resolveAgentPov(dir);
    expect(resolved ? realpathSync.native(resolved) : null).toBe(realpathSync.native(dir));
  });

  it("resolves a registered Space by root_node_id and kind URI", () => {
    const dir = makeAgentDir();
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
    const dir = makeAgentDir();
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

  it("refuses a directory with no Agreement or Foundation contract", () => {
    const dir = tempDir();
    expect(resolveAgentPov(dir)).toBeNull();
    const res = validateAgentPov(dir);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.code).toBe("missing_contract");
      expect(res.message).toContain("has no _agent/agreement.md contract");
    }
  });

  it("refuses a contract that is a symlink escaping the repo root", () => {
    const dir = tempDir();
    const outside = tempDir("outside-");
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "# Leaked\n");

    mkdirSync(join(dir, "_agent"), { recursive: true });
    // symlink _agent/agreement.md to an outside file
    const { symlinkSync } = require("node:fs");
    symlinkSync(outsideFile, join(dir, "_agent", "agreement.md"));

    expect(resolveAgentPov(dir)).toBeNull();
    const res = validateAgentPov(dir);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.code).toBe("symlink_escape");
      expect(res.message).toContain("escapes the repository root");
    }
  });

  it("revalidates a valid POV and detects subsequent contract removal", () => {
    const dir = makeAgentDir();
    const initial = validateAgentPov(dir);
    expect(initial.valid).toBe(true);
    if (initial.valid) {
      const reval = revalidateAgentPov(initial.path);
      expect(reval.valid).toBe(true);
      expect(reval.path).toBe(initial.path);

      // Remove the contract
      rmSync(join(dir, "_agent", "agreement.md"));
      const revalAfter = revalidateAgentPov(initial.path);
      expect(revalAfter.valid).toBe(false);
    }
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
    expect(defaults.model).toBeUndefined();
    expect(defaults.pi_model).toBe("openai/gpt-4o");
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
    expect(defaults.claude_model).toBe("opus");
  });
});

describe("agent run — command options & validation", () => {
  const mockSend = vi.fn<[Record<string, string | boolean>, any], Promise<number>>();
  const mockLocal: LocalConversationOps = {
    send: mockSend,
    createNew: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    canResume: vi.fn(() => true),
  };
  const agentCmd = makeAgentCommand(mockLocal);

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(0);
  });

  it("honors pi_model fallback when runtime is omitted and defaults to pi", async () => {
    const dir = makeAgentDir(
      "agent-run-test-",
      `---\nname: Scout\npi_model: openai/gpt-4o\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", ext: "/approved/connector" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(dir),
        runtime: "pi",
        "pi-model": "openai/gpt-4o",
        "pi-trust": "saved",
        message: "Analyze data",
      }),
      expect.anything(),
      { extraOrientation: expect.stringContaining("# Agreement") },
    );
  });

  it("refuses invocation without a POV argument", async () => {
    const code = await agentCmd.run(["run"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage: ideaspaces agent run");
  });

  it("refuses invocation without --message", async () => {
    const dir = makeAgentDir();
    const code = await agentCmd.run(["run", dir], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("A message is required: --message <text>");
  });

  it("bounds the combined Agreement and pinned Thread orientation before spawn", async () => {
    const root = tempDir();
    const pov = makeAgentDir("large-combined-pov-", `---\nname: Agreement — Fellow\n---\n# Fellow\n${"a".repeat(9_000)}`);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
    mkdirSync(join(root, "_agent"));
    writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Root\nroot_node_id: ${ROOT_A}\n---\n`);
    const thread = createThread("decision", "Decision", root);
    writeFileSync(join(thread.path, "_agent", "agreement.md"), `---\nname: Thread agreement\n---\n# Thread\n${"b".repeat(9_000)}`);
    const post = appendPost(thread.path, { body: "A decision", summary: "Decision summary" });
    git("add", "_agent", "_threads"); git("commit", "-m", "pin");
    const map = join(root, "handoff.json");
    writeFileSync(map, JSON.stringify({ map: { roots: [{ root_node_id: ROOT_A, sha: git("rev-parse", "HEAD") }],
      members: [{ root: 0, position: `_threads/decision/${post.post.path}`, depth: "summary" }] } }));
    const previous = process.cwd(); process.chdir(root);
    try {
      const code = await agentCmd.run(["run", pov], { message: "Read this", thread: thread.path,
        "thread-map": map, "thread-member": "0" }, JSON_GLOBAL);
      expect(code).toBe(1);
      expect(stderr()).toContain("Combined Agreement and Thread orientation exceeds 16 KiB");
    } finally { process.chdir(previous); }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a path-only Thread launch before invoking the runtime", async () => {
    const dir = makeAgentDir();
    const code = await agentCmd.run(["run", dir], { message: "hi", thread: "_threads/decision" }, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("a path alone has no pin");
    expect(mockSend).not.toHaveBeenCalled();
    expect(await agentCmd.run(["run", dir], { message: "hi", thread: "_threads/decision", "thread-map": "handoff.map.md" }, JSON_GLOBAL)).toBe(1);
    expect(await agentCmd.run(["run", dir], { message: "hi", thread: "_threads/decision", "thread-member": "0" }, JSON_GLOBAL)).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses unknown runtime", async () => {
    const dir = makeAgentDir();
    const code = await agentCmd.run(
      ["run", dir],
      { message: "hi", runtime: "unsupported" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain('Unknown local runtime "unsupported"');
  });

  it("bounds the message before any runtime spawn", async () => {
    const dir = makeAgentDir();
    expect(await agentCmd.run(["run", dir], { message: "x".repeat(8 * 1024 + 1) }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("message exceeds 8 KiB");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("bounds the injected Agreement before any runtime spawn", async () => {
    const dir = makeAgentDir("large-agreement-", "x".repeat(16 * 1024 + 1));
    expect(await agentCmd.run(["run", dir], { message: "Hi" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Agreement exceeds 16 KiB");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses launch when target has missing Agreement contract", async () => {
    const emptyDir = tempDir();
    const code = await agentCmd.run(
      ["run", emptyDir],
      { message: "hi" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("has no _agent/agreement.md contract");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses launch when target contract escapes repository root via symlink", async () => {
    const dir = tempDir();
    const outside = tempDir("outside-");
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "# Leaked\n");

    mkdirSync(join(dir, "_agent"), { recursive: true });
    const { symlinkSync } = require("node:fs");
    symlinkSync(outsideFile, join(dir, "_agent", "agreement.md"));

    const code = await agentCmd.run(
      ["run", dir],
      { message: "hi" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("contract escapes the repository root");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("launches an explicit local path to a different unregistered IdeaSpace repo with _agent/agreement.md", async () => {
    const targetDir = makeAgentDir(
      "different-space-",
      `---\nname: Specialist\nruntime: claude\n---\n# Specialist Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", targetDir],
      { message: "Help with analysis" },
      JSON_GLOBAL,
    );
    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(targetDir),
        runtime: "claude",
        message: "Help with analysis",
      }),
      expect.anything(),
      { extraOrientation: expect.stringContaining("# Specialist Agreement") },
    );
  });

  it("forwards flags with Agreement defaults to local.send", async () => {
    const dir = makeAgentDir(
      "agent-run-test-",
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
        context: realpathSync.native(dir),
        runtime: "claude",
        "claude-model": "claude-3-5-sonnet",
        message: "Analyze data",
        conversation: "11111111-1111-4111-8111-111111111111",
      }),
      expect.anything(),
      { extraOrientation: expect.stringContaining("# Agreement") },
    );
  });

  it("CLI flags override Agreement defaults", async () => {
    const dir = makeAgentDir(
      "agent-run-test-",
      `---\nname: Scout\nruntime: claude\nmodel: claude-3-5-sonnet\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", runtime: "pi", model: "gpt-4o", ext: "/approved/connector" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(dir),
        runtime: "pi",
        "pi-model": "gpt-4o",
        message: "Analyze data",
      }),
      expect.anything(),
      { extraOrientation: expect.stringContaining("# Agreement") },
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
  const conversationCmd = makeConversationCommand(localOps);

  const FAKE_CLAUDE = `;
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
  const orientation = args[args.indexOf("--append-system-prompt") + 1] || "";
  const response = prompt.trim() === "orientation_probe" ? (orientation.includes("Distinct Agreement POV") ? "contract:yes" : "contract:no")
    : prompt.trim() === "policy_probe" ? JSON.stringify({ readOnly: args.includes("--tools") && args.includes("--strict-mcp-config"), effort: args[args.indexOf("--effort") + 1] })
    : "claude:" + prompt.trim();
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: response } } });
  out({ type: "result", subtype: "success", is_error: false, result: response, num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 2 } });
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
      const orientation = args[args.indexOf("--append-system-prompt") + 1] || "";
      const frame = command.message === "Pinned question" ? "|" + (orientation.includes("First authored summary") && orientation.includes("Local Thread entry schema") && !orientation.includes("HEAD only") && !orientation.includes("Changed after pin") ? "pinned-frame" : "wrong-frame") : "";
      const answer = command.message === "selection_probe" ? JSON.stringify({ ext: args.filter((arg) => arg === "--extension").length, skill: args.filter((arg) => arg === "--skill").length, noDiscovery: args.includes("--no-extensions") })
        : command.message === "orientation_probe" ? (orientation.includes("Distinct Agreement POV") ? "contract:yes" : "contract:no")
        : command.message === "policy_probe" ? JSON.stringify({ approved: args.includes("-a"), thinking: args[args.indexOf("--thinking") + 1] })
        : "pi:" + command.message + frame;
      if (command.message !== "empty_response") console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } }));
      console.log(JSON.stringify({ type: "agent_end" }));
    }
  }
});
`;

  it("launches at an authored Thread member, appends a named snapshot, and a fresh reader opens it", async () => {
    const root = tempDir();
    const pov = tempDir();
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
    mkdirSync(join(root, "_agent"));
    const rootId = "n_0123456789abcdef01234567";
    writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Local Space\nroot_node_id: ${rootId}\n---\n# Space\n`);
    mkdirSync(join(pov, "_agent"));
    writeFileSync(join(pov, "_agent", "agreement.md"), "---\nname: Agreement — Scout\n---\n# Scout\n");
    const thread = createThread("decision", "Pinned decision", root);
    const first = appendPost(thread.path, { body: "First body at pin", summary: "First authored summary" });
    git("add", "_agent", "_threads"); git("commit", "-m", "pin");
    const pin = git("rev-parse", "HEAD");
    appendPost(thread.path, { body: "Later unpinned post", summary: "HEAD only" });
    writeFileSync(join(thread.path, "_agent", "agreement.md"), "---\nname: Wrong HEAD frame\n---\n# Changed after pin\n");
    const map = join(root, "handoff.map.md");
    const member = `_threads/decision/${first.post.path}`;
    writeFileSync(map, `---\n${stringify({ name: "Handoff", map: { roots: [{ root_node_id: rootId, sha: pin }], members: [{ root: 0, position: member, depth: "summary" }] } })}---\n`);
    const fakeBin = join(pov, "fake-pi");
    writeFileSync(join(pov, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(pov, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);
    const previous = process.cwd(); process.chdir(root);
    try {
      const missing = join(root, "missing.map.md");
      writeFileSync(missing, `---\n${stringify({ map: { roots: [{ root_node_id: rootId, sha: "a".repeat(40) }], members: [{ root: 0, position: member, depth: "summary" }] } })}---\n`);
      expect(() => prepareThreadLaunch(pov, thread.path, map, "-1")).toThrow(/zero-based ordinal/);
      expect(() => prepareThreadLaunch(pov, thread.path, map, "nope")).toThrow(/zero-based ordinal/);
      const wrongRoot = join(root, "wrong-root.map.md");
      writeFileSync(wrongRoot, `---\n${stringify({ map: { roots: [{ root_node_id: "n_aaaaaaaaaaaaaaaaaaaaaaaa", sha: pin }], members: [{ root: 0, position: member, depth: "summary" }] } })}---\n`);
      expect(() => prepareThreadLaunch(pov, thread.path, wrongRoot, "0")).toThrow(/does not identify/);
      const nameOnly = join(root, "name-only.map.md");
      writeFileSync(nameOnly, `---\n${stringify({ map: { roots: [{ root_node_id: rootId, sha: pin }], members: [{ root: 0, position: member, depth: "name" }] } })}---\n`);
      expect(() => prepareThreadLaunch(pov, thread.path, nameOnly, "0")).toThrow(/summary-or-full/);
      const other = createThread("other", "Another Thread", root);
      expect(() => prepareThreadLaunch(pov, other.path, map, "0")).toThrow(/hinted local Thread/);
      const readmeMap = join(root, "readme.map.md");
      writeFileSync(readmeMap, `---\n${stringify({ map: { roots: [{ root_node_id: rootId, sha: pin }], members: [{ root: 0, position: "_threads/decision/README.md", depth: "summary" }] } })}---\n`);
      expect(() => prepareThreadLaunch(pov, thread.path, readmeMap, "0")).toThrow(/post in the hinted/);
      const missingPov = tempDir();
      expect(() => prepareThreadLaunch(missingPov, thread.path, map, "0")).toThrow(/POV needs a regular/);
      mkdirSync(join(missingPov, "_agent"));
      writeFileSync(join(missingPov, "_agent", "agreement.md"), "---\nsummary: no name\n---\n");
      expect(() => prepareThreadLaunch(missingPov, thread.path, map, "0")).toThrow(/needs a name/);
      const invalid = { runtime: "pi", message: "Pinned question", thread: thread.path, "thread-map": missing, "thread-member": "0", ext: "/fake/extension", "pi-bin": fakeBin };
      expect(await agentCmd.run(["run", pov], invalid, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("refusing working-tree HEAD fallback");
      expect(loadThread(thread.path).posts).toHaveLength(2);
      const code = await agentCmd.run(["run", pov], { runtime: "pi", message: "Pinned question", thread: thread.path,
        "thread-map": map, "thread-member": "0", ext: "/fake/extension", "pi-bin": fakeBin }, JSON_GLOBAL);
      expect(code).toBe(0);
      const completed = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete");
      expect(completed.result.thread_snapshot.path).toContain("_threads/decision/");
      const posts = loadThread(thread.path).posts;
      const snapshot = posts.find((post) => post.kind === "snapshot");
      expect(snapshot).toMatchObject({ frontmatter: { author: "Scout", name: "Snapshot — Scout" }, inReplyTo: [first.post.id] });
      expect(snapshot?.body.trim()).toBe("pi:Pinned question|pinned-frame");
      expect(snapshot?.frontmatter.map).toMatchObject({ roots: [{ sha: pin }], members: [{ position: member }] });
      const claudeBin = join(pov, "fake-claude");
      writeFileSync(join(pov, "fake-claude.cjs"), FAKE_CLAUDE);
      writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(pov, "fake-claude.cjs")}" "$@"\n`);
      chmodSync(claudeBin, 0o755);
      stdoutChunks = [];
      expect(await agentCmd.run(["run", pov], { runtime: "claude", message: "Second runtime", thread: thread.path,
        "thread-map": map, "thread-member": "0", "claude-bin": claudeBin }, JSON_GLOBAL)).toBe(0);
      expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete")?.result.thread_snapshot.path).toContain("_threads/decision/");
      expect(loadThread(thread.path).posts.filter((post) => post.kind === "snapshot")).toHaveLength(2);
      // No cursor state or same-process buffer: a fresh CLI read sees the durable snapshot.
      stdoutChunks = [];
      expect(await threadsCommand.run(["open", thread.path], { depth: "full" }, JSON_GLOBAL)).toBe(0);
      expect(stdout()).toContain("pi:Pinned question");
      stdoutChunks = [];
      const pinnedFlags = { runtime: "pi", thread: thread.path, "thread-map": map, "thread-member": "0", ext: "/fake/extension", "pi-bin": fakeBin };
      expect(await agentCmd.run(["run", pov], { ...pinnedFlags, message: "empty_response" }, JSON_GLOBAL)).toBe(1);
      expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).at(-1)).toMatchObject({ type: "error", error_type: "thread_snapshot" });
      expect(stdout()).not.toContain('"type":"turn_complete"');
      expect(loadThread(thread.path).posts).toHaveLength(4);
      chmodSync(thread.path, 0o500);
      try {
        stdoutChunks = [];
        expect(await agentCmd.run(["run", pov], { ...pinnedFlags, message: "Cannot write" }, JSON_GLOBAL)).toBe(1);
        expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).at(-1)).toMatchObject({ type: "error", error_type: "thread_snapshot" });
        expect(stdout()).not.toContain('"type":"turn_complete"');
        stdoutChunks = [];
        expect(await agentCmd.run(["run", pov], { runtime: "claude", message: "Cannot write Claude", thread: thread.path,
          "thread-map": map, "thread-member": "0", "claude-bin": claudeBin }, JSON_GLOBAL)).toBe(1);
        expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).at(-1)).toMatchObject({ type: "error", error_type: "thread_snapshot" });
        expect(stdout()).not.toContain('"type":"turn_complete"');
      } finally { chmodSync(thread.path, 0o700); }
      expect(loadThread(thread.path).posts).toHaveLength(4);
      appendPost(thread.path, { body: "Closed now", kind: "closure" });
      stdoutChunks = [];
      expect(await agentCmd.run(["run", pov], { ...pinnedFlags, message: "After close" }, JSON_GLOBAL)).toBe(1);
      expect(stdout()).toBe(""); // refused before spawning the runtime
      expect(stderr()).toContain("Thread is closed; no agent was launched");
      expect(loadThread(thread.path).posts).toHaveLength(5);
      stdoutChunks = [];
      expect(await agentCmd.run(["run", pov], { message: "No pin", thread: thread.path }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("a path alone has no pin");
    } finally { process.chdir(previous); }
  }, 20_000);

  it("resolves a private orphan Threads worktree at its authored commit", () => {
    const root = tempDir();
    const pov = tempDir();
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
    mkdirSync(join(root, "_agent")); mkdirSync(join(pov, "_agent"));
    const rootId = "n_0123456789abcdef01234567";
    writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Root\nroot_node_id: ${rootId}\n---\n`);
    writeFileSync(join(pov, "_agent", "agreement.md"), "---\nname: Agreement — Scout\n---\n");
    git(root, "add", "_agent"); git(root, "commit", "-m", "root");
    const worktree = initWorktree(root);
    const thread = createThread("decision", "Decision", root);
    const post = appendPost(thread.path, { body: "Private pin", summary: "Private summary" });
    git(worktree, "add", "decision"); git(worktree, "commit", "-m", "pin");
    const pin = git(worktree, "rev-parse", "HEAD");
    const map = join(root, "private.json");
    writeFileSync(map, JSON.stringify({ map: { roots: [{ root_node_id: rootId, sha: pin }],
      members: [{ root: 0, position: `_threads/decision/${post.post.path}`, depth: "summary" }] } }));
    const previous = process.cwd(); process.chdir(root);
    try {
      const frame = prepareThreadLaunch(pov, thread.path, map, "0");
      expect(frame.orientation).toContain("Private summary");
      expect(frame.parentId).toBe(post.post.id);
    } finally { process.chdir(previous); }
  });

  it("conversation send refuses wrong-runtime flags instead of silently ignoring safety policy", async () => {
    const dir = makeAgentDir();
    expect(await conversationCmd.run(["send"], { local: true, runtime: "pi", message: "hi", "read-only": true,
      ext: "/fake/ext", context: dir }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Pi");
    expect(await conversationCmd.run(["send"], { local: true, runtime: "pi", message: "hi", "permission-mode": "bypassPermissions",
      ext: "/fake/ext", context: dir }, JSON_GLOBAL)).toBe(1);
    expect(await conversationCmd.run(["send"], { local: true, runtime: "claude", message: "hi", "pi-trust": "saved",
      context: dir }, JSON_GLOBAL)).toBe(1);
    expect(await conversationCmd.run(["send"], { local: true, runtime: "claude", message: "hi", "pi-thinking": "high",
      context: dir }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Claude");
  });

  it("forwards explicit Pi trust and Claude effort/read-only flags to the selected runtime", async () => {
    const dir = makeAgentDir();
    const pi = join(dir, "pi-test-bin");
    const claude = join(dir, "claude-test-bin");
    writeFileSync(join(dir, "pi-test-bin.cjs"), FAKE_PI);
    writeFileSync(join(dir, "claude-test-bin.cjs"), FAKE_CLAUDE);
    writeFileSync(pi, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "pi-test-bin.cjs")}" "$@"\n`);
    writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "claude-test-bin.cjs")}" "$@"\n`);
    chmodSync(pi, 0o755); chmodSync(claude, 0o755);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "policy_probe", ext: "/fake/ext", "pi-bin": pi, "pi-thinking": "high" }, JSON_GLOBAL)).toBe(0);
    const piDone = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "turn_complete");
    expect(JSON.parse(piDone.result.response)).toEqual({ approved: false, thinking: "high" });
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "policy_probe", ext: "/fake/ext", "pi-bin": pi, "pi-trust": "explicit" }, JSON_GLOBAL)).toBe(0);
    const approved = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "turn_complete");
    expect(JSON.parse(approved.result.response).approved).toBe(true);
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "policy_probe", "claude-bin": claude,
      "claude-effort": "high", "read-only": true, "permission-mode": "dontAsk" }, JSON_GLOBAL)).toBe(0);
    const claudeDone = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "turn_complete");
    expect(JSON.parse(claudeDone.result.response)).toEqual({ readOnly: true, effort: "high" });
  });

  it("loads the selected Agreement into both child runtimes rather than relying on parent hooks", async () => {
    const dir = makeAgentDir("agent-run-orientation-", "# Distinct Agreement POV\n");
    for (const runtime of ["pi", "claude"] as const) {
      const fakeBin = join(dir, `fake-${runtime}`);
      const source = runtime === "pi" ? FAKE_PI : FAKE_CLAUDE;
      writeFileSync(join(dir, `fake-${runtime}.cjs`), source);
      writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `fake-${runtime}.cjs`)}" "$@"\n`);
      chmodSync(fakeBin, 0o755);
      const flags = runtime === "pi" ? { ext: "/fake/ext", "pi-bin": fakeBin } : { "claude-bin": fakeBin };
      const code = await agentCmd.run(["run", dir], { runtime, message: "orientation_probe", ...flags }, JSON_GLOBAL);
      expect(code).toBe(0);
      const events = stdout().trim().split("\n").map((line) => JSON.parse(line));
      expect(events.find((e) => e.type === "turn_complete")?.result.response).toBe("contract:yes");
      stdoutChunks = [];
    }
  });

  it("rejects invalid Pi trust and Claude effort values before starting a child", async () => {
    const dir = makeAgentDir();
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", ext: "/fake/ext", "pi-trust": "unsafe" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid Pi trust policy");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "claude-effort": "infinite" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid Claude effort");
  });

  it("refuses runtime-incompatible controls before spawning", async () => {
    const dir = makeAgentDir();
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", "read-only": true, ext: "/fake/ext" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Pi");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "pi-trust": "saved" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Claude");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "read-only": true, "permission-mode": "bypassPermissions" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("cannot be combined");
  });

  it("fails closed without explicit child resources, rejects a symlink escape, and loads duplicates once", async () => {
    const dir = makeAgentDir();
    const outside = tempDir("other-extension-");
    const extension = join(dir, "approved.ts");
    writeFileSync(extension, "export default () => {};\n");
    symlinkSync(extension, join(dir, "duplicate.ts"));
    writeFileSync(join(outside, "foreign.ts"), "export default () => {};\n");
    symlinkSync(join(outside, "foreign.ts"), join(dir, "escaping.ts"));
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);
    const oldAmbient = process.env.IDEASPACES_PI_EXTENSIONS;
    process.env.IDEASPACES_PI_EXTENSIONS = extension;
    try {
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("explicit trusted extension paths");
      expect(stdout()).toBe("");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: "escaping.ts" }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("Refusing ext path escaping.ts");
      expect(stdout()).toBe("");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: `${extension},${join(dir, "duplicate.ts")},${extension}` }, JSON_GLOBAL)).toBe(0);
      const done = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete");
      expect(JSON.parse(done.result.response)).toEqual({ ext: 1, skill: 0, noDiscovery: true });
    } finally {
      if (oldAmbient === undefined) delete process.env.IDEASPACES_PI_EXTENSIONS;
      else process.env.IDEASPACES_PI_EXTENSIONS = oldAmbient;
    }
  });

  it("refuses unknown, empty and foreign resume ids for both runtimes before spawn", async () => {
    const dir = makeAgentDir();
    const foreign = makeAgentDir();
    const claudeId = "44444444-4444-4444-8444-444444444444";
    const piId = "local-foreign";
    mkdirSync(join(foreign, ".pi", "sessions"), { recursive: true });
    writeFileSync(join(foreign, ".pi", "sessions", `2026_${piId}.jsonl`), `${JSON.stringify({ type: "session", id: piId, cwd: foreign })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "foreign" }] } })}\n`);
    mkdirSync(claudeProjectDir(foreign), { recursive: true });
    writeFileSync(join(claudeProjectDir(foreign), `${claudeId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: claudeId, cwd: foreign, message: { role: "user", content: "foreign" } })}\n`);
    for (const [runtime, id] of [["pi", piId], ["claude", claudeId]] as const) {
      const ext = runtime === "pi" ? { ext: "/approved/connector" } : {};
      expect(await agentCmd.run(["run", dir], { runtime, message: "must not run", conversation: id, ...ext }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain(`No nonempty ${runtime} conversation`);
      expect(await agentCmd.run(["run", foreign], { runtime, message: "must not run", conversation: "typo", ...ext }, JSON_GLOBAL)).toBe(1);
    }
    expect(stdout()).toBe("");
    mkdirSync(join(dir, ".pi", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pi", "sessions", "2026_local-empty.jsonl"), `${JSON.stringify({ type: "session", id: "local-empty", cwd: dir })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", conversation: "local-empty", ext: "/approved/connector" }, JSON_GLOBAL)).toBe(1);
    writeFileSync(join(dir, ".pi", "sessions", "2026_local-foreign-root.jsonl"), `${JSON.stringify({ type: "session", id: "local-foreign-root", cwd: foreign })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "foreign" }] } })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", conversation: "local-foreign-root", ext: "/approved/connector" }, JSON_GLOBAL)).toBe(1);
    const canonicalProject = claudeProjectDir(realpathSync.native(dir));
    mkdirSync(canonicalProject, { recursive: true });
    writeFileSync(join(canonicalProject, `${claudeId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: claudeId, cwd: foreign, message: { role: "user", content: "foreign" } })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "must not run", conversation: claudeId }, JSON_GLOBAL)).toBe(1);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", conversation: true }, JSON_GLOBAL)).toBe(1);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", "session-dir": foreign }, JSON_GLOBAL)).toBe(1);
  });

  it("agent run with claude runtime streams and resumes by --conversation", async () => {
    const dir = makeAgentDir();
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convId = "22222222-2222-4222-8222-222222222222";
    const project = claudeProjectDir(realpathSync.native(dir));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${convId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: convId, cwd: dir, message: { role: "user", content: "earlier" } })}\n`);
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
    const dir = makeAgentDir();
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convId = "local-session-123";
    mkdirSync(join(dir, ".pi", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pi", "sessions", `2026_${convId}.jsonl`), `${JSON.stringify({ type: "session", id: convId, cwd: dir })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "earlier" }] } })}\n`);
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
    const dir = makeAgentDir();
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "auth_fail trigger",
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
    const dir = makeAgentDir();
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
