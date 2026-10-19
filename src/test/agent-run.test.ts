import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { appendPost, createThread, initWorktree, loadThread } from "../local/threads.js";
import { prepareThreadLaunch } from "../local/thread-launch.js";
import { threadsCommand } from "../commands/threads.js";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agentDisplayName, deriveTask, formatAgentRunsText, getAgentRun, listAgentRuns } from "../local/agent-runs.js";
import { makeAgentCommand, readAgentDefaults, resolveAgentPov, revalidateAgentPov, validateAgentPov } from "../commands/agent.js";
import { makeConversationCommand, type LocalConversationOps } from "../commands/conversation.js";
import type { GlobalFlags } from "../types.js";
import { saveSpace } from "../auth/spaces.js";
import { claudeConversationOps } from "../claude/local-conversation-ops.js";
import { localConversationOps as piConversationOps } from "../pi/local-conversation-ops.js";
import { getLocalConversation } from "../pi/local-conversations.js";
import { composeLocalConversationOps } from "../local/runtime.js";
import type { LocalSendOptions } from "../local/send-options.js";
import { canResumeClaudeConversation, claudeProjectDir } from "../claude/local-conversations.js";

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
  const mockSend = vi.fn<[Record<string, string | boolean>, any, LocalSendOptions?], Promise<number>>();
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
    mockSend.mockImplementation(async (_flags, _output, options) => {
      options?.onEvent?.({ type: "turn_complete", result: {
        response: "done", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, cost_usd: 0, model_tier: "local" },
        tool_calls: [], iterations: 1, position: "", workspace: { created: [], modified: [], deleted: [], read: [], mentioned: [] },
      } });
      return 0;
    });
  });

  it("honors pi_model fallback when runtime is omitted and defaults to pi", async () => {
    const dir = makeAgentDir(
      "agent-run-test-",
      `---\nname: Scout\npi_model: openai/gpt-4o\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", ext: join(dir, "_agent", "agreement.md") },
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
      expect.objectContaining({
        extensionPaths: [realpathSync.native(join(dir, "_agent", "agreement.md"))],
        skillPaths: [],
        addedDirs: [],
        agentRun: true,
        resumeOnly: false,
        extraOrientation: expect.stringContaining("# Agreement"),
      }),
    );
  });

  it("reports a silent local runtime return as a terminal JSON error", async () => {
    const dir = makeAgentDir();
    mockSend.mockResolvedValueOnce(0);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({ type: "error", error_type: "run_incomplete", message: expect.stringContaining("No conversation was started") });
  });

  it("does not mistake an error message plus exit 0 for preflight", async () => {
    const dir = makeAgentDir();
    mockSend.mockImplementationOnce(async (_flags, output) => { output.error("startup warning"); return 0; });
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({ type: "error", error_type: "run_incomplete" });
  });

  it("preserves cancelled event and run-record status, but exits nonzero", async () => {
    const dir = makeAgentDir();
    mockSend.mockImplementationOnce(async (_flags, _output, options) => {
      options?.onEvent?.({ type: "cancelled", reason: "aborted" });
      return 0;
    });
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(stdout()).toBe(""); // the adapter owns the actual event emission
    expect(listAgentRuns({ agent: dir }).at(-1)?.status).toBe("cancelled");
  });

  it("keeps synthetic run errors off stdout in human mode", async () => {
    const dir = makeAgentDir();
    mockSend.mockResolvedValueOnce(0);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, { ...JSON_GLOBAL, json: false })).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("run_incomplete");
  });

  it("reports a thrown local runtime failure as a terminal JSON error", async () => {
    const dir = makeAgentDir();
    mockSend.mockRejectedValueOnce(new Error("process exited during a tool call"));
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({ type: "error", error_type: "run_exception", message: expect.stringContaining("process exited during a tool call") });
  });

  it("does not emit a second terminal event when the adapter throws after completion", async () => {
    const dir = makeAgentDir();
    mockSend.mockImplementationOnce(async (_flags, _output, options) => {
      options?.onEvent?.({ type: "turn_complete", result: {
        response: "done", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, cost_usd: 0, model_tier: "local" },
        tool_calls: [], iterations: 1, position: "", workspace: { created: [], modified: [], deleted: [], read: [], mentioned: [] },
      } });
      throw new Error("output pipe closed");
    });
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "Continue", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(stdout()).toBe(""); // the mock does not write its emitted completion
    expect(stderr()).toContain("failed after turn_complete: output pipe closed");
    expect(listAgentRuns({ agent: dir }).at(0)?.status).toBe("completed");
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
      expect.objectContaining({ extensionPaths: [], skillPaths: [], addedDirs: [], allowedTools: expect.any(Array), resumeOnly: false, extraOrientation: expect.stringContaining("# Specialist Agreement") }),
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
      expect.objectContaining({ extensionPaths: [], skillPaths: [], addedDirs: [], allowedTools: expect.any(Array), resumeOnly: true, extraOrientation: expect.stringContaining("# Agreement") }),
    );
  });

  it("CLI flags override Agreement defaults", async () => {
    const dir = makeAgentDir(
      "agent-run-test-",
      `---\nname: Scout\nruntime: claude\nmodel: claude-3-5-sonnet\n---\n# Agreement\n`,
    );

    const code = await agentCmd.run(
      ["run", dir],
      { message: "Analyze data", runtime: "pi", model: "gpt-4o", ext: join(dir, "_agent", "agreement.md") },
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
      expect.objectContaining({
        extensionPaths: [realpathSync.native(join(dir, "_agent", "agreement.md"))],
        skillPaths: [],
        addedDirs: [],
        agentRun: true,
        resumeOnly: false,
        extraOrientation: expect.stringContaining("# Agreement"),
      }),
    );
  });

  it("adds Space root when POV is in a subdirectory of a git repository", async () => {
    const space = tempDir("space-");
    spawnSync("git", ["init", "-q", "-b", "main", space]);
    mkdirSync(join(space, "_threads"));
    const scoutDir = join(space, "agents", "scout");
    mkdirSync(join(scoutDir, "_agent"), { recursive: true });
    writeFileSync(join(scoutDir, "_agent", "agreement.md"), "# Scout Agreement\n");

    const code = await agentCmd.run(
      ["run", scoutDir],
      { message: "Check space", runtime: "claude" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(scoutDir),
        runtime: "claude",
        message: "Check space",
      }),
      expect.anything(),
      expect.objectContaining({
        extensionPaths: [],
        skillPaths: [],
        addedDirs: [realpathSync.native(space)],
        allowedTools: expect.any(Array),
        agentRun: true,
        resumeOnly: false,
        extraOrientation: expect.stringContaining("# Scout Agreement"),
      }),
    );
  });

  it("accepts explicit --reach <dir> flag and adds to addedDirs", async () => {
    const space = tempDir("space-");
    spawnSync("git", ["init", "-q", "-b", "main", space]);
    mkdirSync(join(space, "_threads"));
    const scoutDir = join(space, "agents", "scout");
    mkdirSync(join(scoutDir, "_agent"), { recursive: true });
    writeFileSync(join(scoutDir, "_agent", "agreement.md"), "# Scout Agreement\n");

    const otherDir = tempDir("other-repo-");

    const code = await agentCmd.run(
      ["run", scoutDir],
      { message: "Check reach", runtime: "claude", reach: otherDir },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(scoutDir),
        runtime: "claude",
        message: "Check reach",
      }),
      expect.anything(),
      expect.objectContaining({
        extensionPaths: [],
        skillPaths: [],
        addedDirs: [realpathSync.native(space), realpathSync.native(otherDir)],
        allowedTools: expect.any(Array),
        agentRun: true,
        resumeOnly: false,
        extraOrientation: expect.stringContaining("# Scout Agreement"),
      }),
    );
  });

  it("keeps discovered-Map warnings on stderr in JSON mode", async () => {
    const dir = makeAgentDir();
    writeFileSync(join(dir, "home.map.md"), "---\nname: Broken\nmap: invalid\n---\n");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi" }, JSON_GLOBAL)).toBe(0);
    expect(stderr()).toContain("Reach warning: Could not discover reach from Map home.map.md");
    expect(stdout()).not.toContain("Reach warning:");
  });

  it("refuses non-existent --reach path", async () => {
    const dir = makeAgentDir();
    const code = await agentCmd.run(
      ["run", dir],
      { message: "Check bad reach", runtime: "claude", reach: "/nonexistent/directory/path" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("directory not found");
  });

  it("refuses a bare --reach flag with no directory value", async () => {
    const dir = makeAgentDir();
    const code = await agentCmd.run(
      ["run", dir],
      { message: "Check bare reach", runtime: "claude", reach: true },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("--reach requires a directory path");
  });

  it("does not discover Claude reach for a Pi run with a malformed Map", async () => {
    const dir = makeAgentDir();
    writeFileSync(join(dir, "broken.map.md"), "---\nmap: invalid\n---\n");
    const code = await agentCmd.run(["run", dir], {
      runtime: "pi", message: "Analyze", ext: join(dir, "_agent", "agreement.md"), map: "broken.map.md",
    }, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ addedDirs: [] }));
  });

  it("refuses --reach under Pi runtime", async () => {
    const dir = makeAgentDir();
    const other = tempDir();
    const code = await agentCmd.run(
      ["run", dir],
      { message: "Check reach under pi", runtime: "pi", reach: other, ext: join(dir, "_agent", "agreement.md") },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("reach, and permission mode are unavailable under Pi");
  });

  it("combines --reach with --read-only on Claude", async () => {
    const space = tempDir("space-");
    spawnSync("git", ["init", "-q", "-b", "main", space]);
    mkdirSync(join(space, "_threads"));
    const scoutDir = join(space, "agents", "scout");
    mkdirSync(join(scoutDir, "_agent"), { recursive: true });
    writeFileSync(join(scoutDir, "_agent", "agreement.md"), "# Scout Agreement\n");
    const otherDir = tempDir("other-repo-");

    const code = await agentCmd.run(
      ["run", scoutDir],
      { message: "Read reach", runtime: "claude", "read-only": true, reach: otherDir },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        context: realpathSync.native(scoutDir),
        runtime: "claude",
        "read-only": true,
        message: "Read reach",
      }),
      expect.anything(),
      expect.objectContaining({
        addedDirs: [realpathSync.native(space), realpathSync.native(otherDir)],
        allowedTools: ["Read", "Grep", "Glob"],
      }),
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
    : prompt.trim() === "policy_probe" ? JSON.stringify({ readOnly: args.includes("--tools") && (args.includes("--strict-mcp-config") || args.includes("--disallowedTools")), effort: args[args.indexOf("--effort") + 1] })
    : "claude:" + prompt.trim();
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: response } } });
  out({ type: "result", subtype: "success", is_error: false, result: response, num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 2 } });
});
`;

  const FAKE_PI = `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const sessionId = args[args.indexOf('--session-id') + 1];
const sessionDir = args[args.indexOf('--session-dir') + 1];
const transcript = path.join(sessionDir, '2026_' + sessionId + '.jsonl');
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
      const pattern = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
      const model = command.id === "__state" ? { provider: "fake", id: pattern ? "resolved-" + pattern.split("/").pop() : "default-model" } : undefined;
      const saved = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'session_info').at(-1)?.name : null;
      console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionName: args.includes("--name") ? (args[args.indexOf("--name") + 1] === "Rejected topic" ? null : args[args.indexOf("--name") + 1]) : saved ?? null, model } }));
    }
    if (command.type === 'set_session_name' && fs.existsSync(transcript)) fs.appendFileSync(transcript, JSON.stringify({type:'session_info', name:command.name}) + '\\n');
    if (command.type === "prompt") {
      if (command.message === 'topic_probe') {
        if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, JSON.stringify({type:'session',id:sessionId,cwd:process.cwd()}) + '\\n');
        if (args.includes('--name')) fs.appendFileSync(transcript, JSON.stringify({type:'session_info',name:args[args.indexOf('--name')+1]}) + '\\n');
        fs.appendFileSync(transcript, JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:command.message}]}}) + '\\n');
      }
      if (command.message.includes("auth_fail")) {
        console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "Authentication failed: invalid token" }));
        return;
      }
      console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "turn_start" }));
      const orientation = args[args.indexOf("--append-system-prompt") + 1] || "";
      const frame = command.message === "Pinned question" ? "|" + (orientation.includes("First authored summary") && orientation.includes("Local Thread entry schema") && !orientation.includes("HEAD only") && !orientation.includes("Changed after pin") ? "pinned-frame" : "wrong-frame") : "";
      const answer = command.message === "topic_probe" ? JSON.stringify({ name: args.includes("--name") ? args[args.indexOf("--name") + 1] : null, resumed: args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : null })
        : command.message === "selection_probe" ? JSON.stringify({ ext: args.filter((arg) => arg === "--extension").length, paths: args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : []), skill: args.filter((arg) => arg === "--skill").length, noDiscovery: args.includes("--no-extensions"), noSkillsDiscovery: args.includes("--no-skills") })
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
      const invalid = { runtime: "pi", message: "Pinned question", thread: thread.path, "thread-map": missing, "thread-member": "0", ext: fakeBin, "pi-bin": fakeBin };
      expect(await agentCmd.run(["run", pov], invalid, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("refusing working-tree HEAD fallback");
      expect(loadThread(thread.path).posts).toHaveLength(2);
      const code = await agentCmd.run(["run", pov], { runtime: "pi", message: "Pinned question", thread: thread.path,
        "thread-map": map, "thread-member": "0", ext: fakeBin, "pi-bin": fakeBin }, JSON_GLOBAL);
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
      const pinnedFlags = { runtime: "pi", thread: thread.path, "thread-map": map, "thread-member": "0", ext: fakeBin, "pi-bin": fakeBin };
      expect(await agentCmd.run(["run", pov], { ...pinnedFlags, message: "empty_response" }, JSON_GLOBAL)).toBe(1);
      expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).at(-1)).toMatchObject({ type: "error", error_type: "thread_snapshot" });
      expect(stdout().trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "error")).toHaveLength(1);
      expect(listAgentRuns({ agent: pov }).at(0)?.status).toBe("failed");
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
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "policy_probe", ext: pi, "pi-bin": pi, "pi-thinking": "high" }, JSON_GLOBAL)).toBe(0);
    const piEvents = stdout().trim().split("\n").map((line) => JSON.parse(line));
    const piDone = piEvents.find((e) => e.type === "turn_complete");
    expect(piEvents.find((e) => e.type === "message_start")).toMatchObject({ trust: "saved", added_dirs: [], allowed_tools: null, extensions: [realpathSync.native(pi)] });
    expect(JSON.parse(piDone.result.response)).toEqual({ approved: false, thinking: "high" });
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "policy_probe", ext: pi, "pi-bin": pi, "pi-trust": "explicit" }, JSON_GLOBAL)).toBe(0);
    const explicitEvents = stdout().trim().split("\n").map((line) => JSON.parse(line));
    const approved = explicitEvents.find((e) => e.type === "turn_complete");
    expect(explicitEvents.find((e) => e.type === "message_start")).toMatchObject({ trust: "explicit", added_dirs: [], allowed_tools: null });
    expect(JSON.parse(approved.result.response).approved).toBe(true);
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "policy_probe", "claude-bin": claude,
      "claude-effort": "high", "read-only": true, "permission-mode": "dontAsk" }, JSON_GLOBAL)).toBe(0);
    const claudeDone = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "turn_complete");
    expect(JSON.parse(claudeDone.result.response)).toEqual({ readOnly: true, effort: "high" });
  });

  it("reports the requested and the runtime-observed model separately", async () => {
    const dir = makeAgentDir();
    const pi = join(dir, "pi-test-bin");
    const claude = join(dir, "claude-test-bin");
    writeFileSync(join(dir, "pi-test-bin.cjs"), FAKE_PI);
    writeFileSync(join(dir, "claude-test-bin.cjs"), FAKE_CLAUDE);
    writeFileSync(pi, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "pi-test-bin.cjs")}" "$@"\n`);
    writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "claude-test-bin.cjs")}" "$@"\n`);
    chmodSync(pi, 0o755); chmodSync(claude, 0o755);
    const start = () => stdout().trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "message_start");

    // No override: "local" stays the legacy tier label, never the observed model.
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", ext: pi, "pi-bin": pi }, JSON_GLOBAL)).toBe(0);
    expect(start()).toMatchObject({ runtime: "pi", model: "local", model_requested: null, model_observed: "fake/default-model" });
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", ext: pi, "pi-bin": pi, model: "openai/gpt-x" }, JSON_GLOBAL)).toBe(0);
    expect(start()).toMatchObject({ model: "openai/gpt-x", model_requested: "openai/gpt-x", model_observed: "fake/resolved-gpt-x" });
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "claude-bin": claude, model: "sonnet" }, JSON_GLOBAL)).toBe(0);
    expect(start()).toMatchObject({ runtime: "claude", model_requested: "sonnet", model_observed: "claude-fake" });
    stdoutChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "claude-bin": claude }, JSON_GLOBAL)).toBe(0);
    expect(start()).toMatchObject({ model_requested: null, model_observed: "claude-fake" });
  });

  it("publishes agent-run guarantees as data, never as help prose", async () => {
    expect(await agentCmd.run(["capabilities"], {}, JSON_GLOBAL)).toBe(0);
    const caps = JSON.parse(stdout());
    expect(caps).toEqual({
      schema: "ideaspaces.agent-run.capabilities",
      version: 1,
      features: [
        "pi.explicit-extensions",
        "pi.retry-terminal",
        "pi.skill-isolation",
        "pi.trust",
        "pi.thinking",
        "pi.topic",
        "claude.read-only",
        "claude.effort",
        "claude.permission-mode",
        "model.requested-observed",
        "run.records",
        "run.record-command",
        "run.terminal-error",
        "run.cancelled-nonzero",
      ],
    });
  });

  it("loads the selected Agreement into both child runtimes rather than relying on parent hooks", async () => {
    const dir = makeAgentDir("agent-run-orientation-", "# Distinct Agreement POV\n");
    for (const runtime of ["pi", "claude"] as const) {
      const fakeBin = join(dir, `fake-${runtime}`);
      const source = runtime === "pi" ? FAKE_PI : FAKE_CLAUDE;
      writeFileSync(join(dir, `fake-${runtime}.cjs`), source);
      writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `fake-${runtime}.cjs`)}" "$@"\n`);
      chmodSync(fakeBin, 0o755);
      const flags = runtime === "pi" ? { ext: fakeBin, "pi-bin": fakeBin } : { "claude-bin": fakeBin };
      const code = await agentCmd.run(["run", dir], { runtime, message: "orientation_probe", ...flags }, JSON_GLOBAL);
      expect(code).toBe(0);
      const events = stdout().trim().split("\n").map((line) => JSON.parse(line));
      expect(events.find((e) => e.type === "turn_complete")?.result.response).toBe("contract:yes");
      stdoutChunks = [];
    }
  });

  it("rejects invalid Pi trust and Claude effort values before starting a child", async () => {
    const dir = makeAgentDir();
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", ext: join(dir, "_agent", "agreement.md"), "pi-trust": "unsafe" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid Pi trust policy");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "claude-effort": "infinite" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid Claude effort");
  });

  it("refuses runtime-incompatible controls before spawning", async () => {
    const dir = makeAgentDir();
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "hi", "read-only": true, ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Pi");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "pi-trust": "saved" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("unavailable under Claude");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Pi --ext and --skill paths are unavailable under Claude");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", skill: true }, JSON_GLOBAL)).toBe(1);
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "permission-mode": "bypassPermissions" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("bypassPermissions");
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hi", "permission-mode": "auto" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("cannot reliably set auto");
  });

  it("fails closed without explicit child resources, rejects a symlink escape, and loads duplicates once", async () => {
    const dir = makeAgentDir();
    const outside = tempDir("other-extension-");
    const extension = join(dir, "approved.ts");
    writeFileSync(extension, "export default () => {};\n");
    symlinkSync(extension, join(dir, "duplicate.ts"));
    writeFileSync(join(outside, "foreign.ts"), "export default () => {};\n");
    symlinkSync(join(outside, "foreign.ts"), join(dir, "..escaping.ts"));
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);
    const oldAmbient = process.env.IDEASPACES_PI_EXTENSIONS;
    process.env.IDEASPACES_PI_EXTENSIONS = extension;
    try {
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("explicit trusted extension paths");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: " , " }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("explicit trusted extension paths");
      expect(stdout()).toBe("");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: "missing.ts" }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("path not found");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: extension, skill: "..escaping.ts" }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("Refusing skill path ..escaping.ts");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: extension, skill: true }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("a bare flag selects nothing");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: "..escaping.ts" }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("Refusing ext path ..escaping.ts");
      expect(stdout()).toBe("");
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: `${extension},${join(dir, "duplicate.ts")},approved.ts,./approved.ts` }, JSON_GLOBAL)).toBe(0);
      const done = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete");
      expect(JSON.parse(done.result.response)).toEqual({ ext: 1, paths: [realpathSync.native(extension)], skill: 0, noDiscovery: true, noSkillsDiscovery: true });
      const skills = join(dir, "skills");
      mkdirSync(skills);
      stdoutChunks = [];
      expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: extension, skill: `${skills},./skills` }, JSON_GLOBAL)).toBe(0);
      const withSkills = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete");
      expect(JSON.parse(withSkills.result.response)).toMatchObject({ skill: 1, noSkillsDiscovery: true });
      const alias = join(outside, "agent-alias");
      symlinkSync(dir, alias);
      stdoutChunks = [];
      expect(await agentCmd.run(["run", alias], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: join(alias, "..escaping.ts") }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain("escapes the selected POV");
      expect(stdout()).toBe("");
      expect(await agentCmd.run(["run", alias], { runtime: "pi", message: "selection_probe", "pi-bin": fakeBin, ext: "approved.ts" }, JSON_GLOBAL)).toBe(0);
      stdoutChunks = [];
      expect(await conversationCmd.run(["send"], { local: true, runtime: "pi", context: dir, message: "selection_probe", "pi-bin": fakeBin, "explicit-launch": true, "resume-only": true }, JSON_GLOBAL)).toBe(0);
      const direct = stdout().trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "turn_complete");
      expect(JSON.parse(direct.result.response)).toMatchObject({ ext: 1, noSkillsDiscovery: false }); // legacy send keeps discovery
    } finally {
      if (oldAmbient === undefined) delete process.env.IDEASPACES_PI_EXTENSIONS;
      else process.env.IDEASPACES_PI_EXTENSIONS = oldAmbient;
    }
  });

  it("rechecks at send when a transcript vanishes after agent preflight", async () => {
    const dir = makeAgentDir();
    const selected = makeAgentCommand({ ...localOps, canResume: () => true });
    for (const [runtime, id] of [["pi", "local-deleted"], ["claude", "55555555-5555-4555-8555-555555555555"]] as const) {
      const ext = runtime === "pi" ? { ext: join(dir, "_agent", "agreement.md") } : {};
      const code = await selected.run(["run", dir], { runtime, conversation: id, message: "never spawn", ...ext }, JSON_GLOBAL);
      expect(code).toBe(1);
      expect(stderr()).toContain("refusing to create a replacement");
      expect(stdout()).toBe(""); // late preflight refusal, not a dropped turn
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
      const ext = runtime === "pi" ? { ext: join(dir, "_agent", "agreement.md") } : {};
      expect(await agentCmd.run(["run", dir], { runtime, message: "must not run", conversation: id, ...ext }, JSON_GLOBAL)).toBe(1);
      expect(stderr()).toContain(`No verified nonempty ${runtime} conversation`);
      expect(await agentCmd.run(["run", foreign], { runtime, message: "must not run", conversation: "typo", ...ext }, JSON_GLOBAL)).toBe(1);
    }
    expect(stdout()).toBe("");
    mkdirSync(join(dir, ".pi", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pi", "sessions", "2026_local-empty.jsonl"), `${JSON.stringify({ type: "session", id: "local-empty", cwd: dir })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", conversation: "local-empty", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    writeFileSync(join(dir, ".pi", "sessions", "2026_local-foreign-root.jsonl"), `${JSON.stringify({ type: "session", id: "local-foreign-root", cwd: foreign })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "foreign" }] } })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "pi", message: "must not run", conversation: "local-foreign-root", ext: join(dir, "_agent", "agreement.md") }, JSON_GLOBAL)).toBe(1);
    const canonicalProject = claudeProjectDir(realpathSync.native(dir));
    mkdirSync(canonicalProject, { recursive: true });
    writeFileSync(join(canonicalProject, `${claudeId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: claudeId, cwd: foreign, message: { role: "user", content: "foreign" } })}\n`);
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "must not run", conversation: claudeId }, JSON_GLOBAL)).toBe(1);
    const validId = "66666666-6666-4666-8666-666666666666";
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const validFile = join(canonicalProject, `${validId}.jsonl`);
    const initial = JSON.stringify({ type: "user", sessionId: validId, cwd: dir, message: { role: "user", content: "before" } });
    writeFileSync(validFile, `${initial}\n${JSON.stringify({ type: "assistant", sessionId: validId, cwd: sub, message: { role: "assistant", id: "m1", content: [{ type: "text", text: "reply" }] } })}\n{"type":"user"`);
    expect(canResumeClaudeConversation(realpathSync.native(dir), validId)).toBe(true); // torn final line, child cwd
    writeFileSync(validFile, `${initial}\n{"type":"user"\n${JSON.stringify({ type: "user", sessionId: validId, cwd: dir, message: { role: "user", content: "after" } })}\n`);
    expect(canResumeClaudeConversation(realpathSync.native(dir), validId)).toBe(false); // corruption in the middle
    writeFileSync(validFile, `${JSON.stringify({ type: "user", sessionId: validId, cwd: dir, isSidechain: true, message: { role: "user", content: "sidechain" } })}\n`);
    expect(canResumeClaudeConversation(realpathSync.native(dir), validId)).toBe(false);
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
        ext: `${fakeBin},${fakeBin}`,
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

  it("names only new Pi runs explicitly, preserving the unnamed fallback and refusing Claude/resume topics before spawn", async () => {
    const dir = makeAgentDir();
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);
    const run = (flags: Record<string, string | boolean>) => agentCmd.run(["run", dir], {
      runtime: "pi", message: "topic_probe", ext: fakeBin, "pi-bin": fakeBin, ...flags,
    }, JSON_GLOBAL);
    expect(await run({ topic: "  Exact Pi topic  " })).toBe(0);
    const lines = stdout().trim().split("\n").map((l) => JSON.parse(l));
    const first = lines.find((e) => e.type === "turn_complete");
    expect(JSON.parse(first.result.response).name).toBe("Exact Pi topic");
    const conversationId = lines.find((e) => e.type === "message_start").conversation_id;
    expect(getLocalConversation(dir, conversationId).name).toBe("Exact Pi topic");
    stdoutChunks = [];
    expect(await run({ conversation: conversationId })).toBe(0);
    expect(getLocalConversation(dir, conversationId).name).toBe("Exact Pi topic");
    stdoutChunks = [];
    expect(await run({})).toBe(0);
    const unnamed = stdout().trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "turn_complete");
    expect(JSON.parse(unnamed.result.response).name).toBeNull();
    const unnamedId = stdout().trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "message_start").conversation_id;
    expect(getLocalConversation(dir, unnamedId).name).toBe("topic_probe");
    stdoutChunks = [];
    expect(await run({ topic: "Rejected topic" })).toBe(1);
    const refused = stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(refused.some((e) => e.type === "message_start" || e.type === "turn_complete")).toBe(false);
    expect(refused.find((e) => e.type === "error")?.error_type).toBe("pi_session_name");
    for (const topic of [true, "  ", "x".repeat(201)]) {
      stderrChunks = [];
      expect(await run({ topic })).toBe(1);
      expect(stderr()).toContain("--topic requires");
    }
    stderrChunks = [];
    expect(await agentCmd.run(["run", dir], { runtime: "claude", message: "hello", topic: "No Claude" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Claude naming is not supported");
    stderrChunks = [];
    expect(await run({ topic: "No resume", conversation: "local-session-123" })).toBe(1);
    expect(stderr()).toContain("omit it when resuming");
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
        ext: `${fakeBin},${fakeBin}`,
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

  it("writes run records on agent run and reads them back via agent runs", async () => {
    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ runs: [], total: 0 });

    const dir = makeAgentDir("run-record-test-");
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    stdoutChunks = [];
    const code = await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "hello claude",
        "claude-bin": fakeBin,
        parent: "parent-session-123",
        "parent-tool-use-id": "toolu_01abc",
      },
      JSON_GLOBAL,
    );
    expect(code).toBe(0);

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, JSON_GLOBAL)).toBe(0);
    const allRuns = JSON.parse(stdout());
    expect(allRuns.total).toBe(1);
    const record = allRuns.runs[0];
    expect(record.parent_id).toBe("parent-session-123");
    expect(record.parent_tool_use_id).toBe("toolu_01abc");
    expect(record.agent).toBe(realpathSync.native(dir));
    expect(record.task).toBe("hello claude");
    expect(record.harness).toBe("claude");
    expect(record.model).toBe("claude-fake");
    expect(record.status).toBe("completed");
    expect(record.conversation_id).toBeTruthy();
    expect(record.started_at).toBeTruthy();
    expect(record.ended_at).toBeTruthy();

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], { parent: "parent-session-123" }, JSON_GLOBAL)).toBe(0);
    const filtered = JSON.parse(stdout());
    expect(filtered.total).toBe(1);
    expect(filtered.runs[0].run_id).toBe(record.run_id);

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], { parent: "different-parent" }, JSON_GLOBAL)).toBe(0);
    const none = JSON.parse(stdout());
    expect(none.total).toBe(0);
    expect(none.runs).toEqual([]);

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, { json: false, quiet: false, yes: false, help: false })).toBe(0);
    expect(stdout()).toContain('· "hello claude" · claude · claude-fake · completed — runId: ');
    expect(stdout()).toContain("(parent: parent-session-123)");
  });

  it("derives task from dispatch post name, ask question, and consult message", async () => {
    const dir = makeAgentDir("run-task-derive-test-");
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    // 1. Post path in message
    const postFile = join(dir, "dispatch.md");
    writeFileSync(
      postFile,
      `---
id: msg_test_123
date: 2026-10-12T15:00:00.000Z
kind: post
name: "Dispatch: UI/UX builds M1 then SH"
author: steward
---
Post body
`,
    );

    stdoutChunks = [];
    await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: `${postFile} — a dispatch addressed to you. Read it and do it; post your result in that Thread...`,
        "claude-bin": fakeBin,
        "run-id": "run-post-task",
      },
      JSON_GLOBAL,
    );

    // 2. Ask question format
    stdoutChunks = [];
    await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "What is the capital of France? — a question, answered in your reply only. Read what you need; write nothing, post nothing.",
        "claude-bin": fakeBin,
        "run-id": "run-ask-task",
      },
      JSON_GLOBAL,
    );

    // 3. Consult format
    stdoutChunks = [];
    await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "Review the authentication flow — a consult from integrator, about the Thread at _threads/auth.",
        "claude-bin": fakeBin,
        "run-id": "run-consult-task",
      },
      JSON_GLOBAL,
    );

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, JSON_GLOBAL)).toBe(0);
    const runs = JSON.parse(stdout()).runs;
    const postRun = runs.find((r: any) => r.run_id === "run-post-task");
    const askRun = runs.find((r: any) => r.run_id === "run-ask-task");
    const consultRun = runs.find((r: any) => r.run_id === "run-consult-task");

    expect(postRun.task).toBe("Dispatch: UI/UX builds M1 then SH");
    expect(askRun.task).toBe("What is the capital of France?");
    expect(consultRun.task).toBe("Review the authentication flow");

    // 4. Explicit --task override
    stdoutChunks = [];
    await agentCmd.run(
      ["run", dir],
      {
        runtime: "claude",
        model: "sonnet",
        message: "Some message",
        task: "Explicit task name",
        "claude-bin": fakeBin,
        "run-id": "run-explicit-task",
      },
      JSON_GLOBAL,
    );
    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, JSON_GLOBAL)).toBe(0);
    const explicitRun = JSON.parse(stdout()).runs.find((r: any) => r.run_id === "run-explicit-task");
    expect(explicitRun.task).toBe("Explicit task name");
  });

  it("deriveTask unit tests cover post names, prompts, sanitization and edge cases", () => {
    const dir = tempDir("derive-task-unit-");
    const postFile = join(dir, "post.md");
    writeFileSync(
      postFile,
      `---
id: msg_abc
date: 2026-10-12T15:00:00.000Z
kind: post
name: "Post Name From Frontmatter"
author: scout
---
Body text
`,
    );

    // From file path directly
    expect(deriveTask(postFile, dir)).toBe("Post Name From Frontmatter");
    // From dispatch message with file path
    expect(deriveTask(`${postFile} — a dispatch addressed to you. Read it...`, dir)).toBe("Post Name From Frontmatter");
    // Non-existent .md path falls back to first line
    expect(deriveTask("missing.md — a dispatch addressed to you", dir)).toBe("missing.md");
    // Markdown without frontmatter name falls back to first line
    const bareMd = join(dir, "bare.md");
    writeFileSync(bareMd, "# Bare Title\nbody");
    expect(deriveTask(bareMd, dir)).toBe(bareMd);

    // Ask format
    expect(deriveTask("Why is the sky blue? — a question, answered in your reply only.", dir)).toBe("Why is the sky blue?");
    // Consult format
    expect(deriveTask("Look at logs — a consult from backend, about the Thread...", dir)).toBe("Look at logs");
    // Ceiling note
    expect(deriveTask("Run migration Ceiling for this run: 10 minutes.", dir)).toBe("Run migration");
    // Multi-line message
    expect(deriveTask("First line\nSecond line\nThird line", dir)).toBe("First line");
    // Empty and whitespace messages
    expect(deriveTask("", dir)).toBeNull();
    expect(deriveTask("   \n\n  ", dir)).toBeNull();
    expect(deriveTask(undefined, dir)).toBeNull();

    // Long message truncation to 300 chars
    const long = "A".repeat(400);
    expect(deriveTask(long, dir)?.length).toBe(300);
  });

  it("inherits parent_id from PI_SESSION_ID when --parent is omitted", async () => {
    const dir = makeAgentDir("run-env-parent-test-");
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    process.env.PI_SESSION_ID = "pi-parent-456";
    try {
      stdoutChunks = [];
      const code = await agentCmd.run(
        ["run", dir],
        {
          runtime: "claude",
          model: "sonnet",
          message: "hello from pi child",
          "claude-bin": fakeBin,
        },
        JSON_GLOBAL,
      );
      expect(code).toBe(0);

      stdoutChunks = [];
      expect(await agentCmd.run(["runs"], { parent: "pi-parent-456" }, JSON_GLOBAL)).toBe(0);
      const res = JSON.parse(stdout());
      expect(res.total).toBe(1);
      expect(res.runs[0].parent_id).toBe("pi-parent-456");
    } finally {
      delete process.env.PI_SESSION_ID;
    }
  });

  it("validates --limit and filters by --agent and --limit", async () => {
    stdoutChunks = [];
    stderrChunks = [];
    expect(await agentCmd.run(["runs"], { limit: "invalid" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid --limit: must be a positive integer");

    stdoutChunks = [];
    stderrChunks = [];
    expect(await agentCmd.run(["runs"], { limit: "0" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid --limit: must be a positive integer");

    const dirA = makeAgentDir("agent-a-");
    const dirB = makeAgentDir("agent-b-");
    const fakeBinA = join(dirA, "fake-claude");
    writeFileSync(join(dirA, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBinA, `#!/bin/sh\nexec "${process.execPath}" "${join(dirA, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBinA, 0o755);

    const fakeBinB = join(dirB, "fake-claude");
    writeFileSync(join(dirB, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBinB, `#!/bin/sh\nexec "${process.execPath}" "${join(dirB, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBinB, 0o755);

    await agentCmd.run(["run", dirA], { runtime: "claude", message: "m1", "claude-bin": fakeBinA }, JSON_GLOBAL);
    await agentCmd.run(["run", dirB], { runtime: "claude", message: "m2", "claude-bin": fakeBinB }, JSON_GLOBAL);

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], { agent: basename(dirA) }, JSON_GLOBAL)).toBe(0);
    const runsA = JSON.parse(stdout());
    expect(runsA.total).toBe(1);
    expect(runsA.runs[0].agent).toBe(realpathSync.native(dirA));

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], { limit: "1" }, JSON_GLOBAL)).toBe(0);
    const runsLimit = JSON.parse(stdout());
    expect(runsLimit.total).toBe(1);
  });

  it("extracts agent display name and filters by relative and Windows agent paths", () => {
    expect(agentDisplayName("/path/to/agents/scout")).toBe("scout");
    expect(agentDisplayName("C:\\path\\to\\agents\\scout")).toBe("scout");
    expect(agentDisplayName("/path/to/agents/scout/")).toBe("scout");
    expect(agentDisplayName("C:\\path\\to\\agents\\scout\\")).toBe("scout");
    expect(agentDisplayName("scout")).toBe("scout");

    const formatted = formatAgentRunsText([
      {
        run_id: "run-win",
        parent_id: null,
        agent: "C:\\Workspace\\agents\\scout",
        harness: "pi",
        model: "gemini-3.7-flash",
        conversation_id: "local-123",
        status: "completed",
        started_at: "2026-10-12T12:00:00.000Z",
        ended_at: "2026-10-12T12:01:00.000Z",
      },
    ]);
    expect(formatted).toContain("scout · pi · gemini-3.7-flash · completed — runId: run-win");
  });

  it("records failed status when child run fails", async () => {
    const dir = makeAgentDir("failed-run-test-");
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

    stdoutChunks = [];
    expect(await agentCmd.run(["runs"], {}, JSON_GLOBAL)).toBe(0);
    const allRuns = JSON.parse(stdout());
    const failedRun = allRuns.runs.find((r: { agent: string }) => r.agent === realpathSync.native(dir));
    expect(failedRun).toBeTruthy();
    expect(failedRun.status).toBe("failed");
    expect(failedRun.ended_at).toBeTruthy();
  });

  it("conversation send --local defaults Pi trust to saved and passes -a only on explicit", async () => {
    const dir = makeAgentDir("conv-send-trust-test-");
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    const convCmd = makeConversationCommand(composeLocalConversationOps({ pi: piConversationOps, claude: claudeConversationOps }));

    stdoutChunks = [];
    const code1 = await convCmd.run(
      ["send", dir, "conv1"],
      {
        local: true,
        runtime: "pi",
        message: "policy_probe",
        ext: `${fakeBin},${fakeBin}`,
        "pi-bin": fakeBin,
      },
      JSON_GLOBAL,
    );
    expect(code1).toBe(0);
    const lines1 = stdout().trim().split("\n").map((l) => JSON.parse(l));
    const start1 = lines1.find((e) => e.type === "message_start");
    expect(start1.trust).toBe("saved");
    const delta1 = lines1.find((e) => e.type === "text_delta");
    const probe1 = JSON.parse(delta1.delta.replace(/^pi:/, ""));
    expect(probe1.approved).toBe(false);

    stdoutChunks = [];
    const code2 = await convCmd.run(
      ["send", dir, "conv1"],
      {
        local: true,
        runtime: "pi",
        message: "policy_probe",
        ext: `${fakeBin},${fakeBin}`,
        "pi-bin": fakeBin,
        "pi-trust": "explicit",
      },
      JSON_GLOBAL,
    );
    expect(code2).toBe(0);
    const lines2 = stdout().trim().split("\n").map((l) => JSON.parse(l));
    const start2 = lines2.find((e) => e.type === "message_start");
    expect(start2.trust).toBe("explicit");
    const delta2 = lines2.find((e) => e.type === "text_delta");
    const probe2 = JSON.parse(delta2.delta.replace(/^pi:/, ""));
    expect(probe2.approved).toBe(true);
  });

  it("agent run defaults Pi trust to saved and passes -a only on explicit", async () => {
    const dir = makeAgentDir("agent-run-trust-test-");
    const fakeBin = join(dir, "fake-pi");
    writeFileSync(join(dir, "fake-pi.cjs"), FAKE_PI);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-pi.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    stdoutChunks = [];
    const code1 = await agentCmd.run(
      ["run", dir],
      {
        runtime: "pi",
        message: "policy_probe",
        ext: `${fakeBin},${fakeBin}`,
        "pi-bin": fakeBin,
      },
      JSON_GLOBAL,
    );
    expect(code1).toBe(0);
    const lines1 = stdout().trim().split("\n").map((l) => JSON.parse(l));
    const start1 = lines1.find((e) => e.type === "message_start");
    expect(start1.trust).toBe("saved");
    const delta1 = lines1.find((e) => e.type === "text_delta");
    const probe1 = JSON.parse(delta1.delta.replace(/^pi:/, ""));
    expect(probe1.approved).toBe(false);

    stdoutChunks = [];
    const code2 = await agentCmd.run(
      ["run", dir],
      {
        runtime: "pi",
        message: "policy_probe",
        ext: `${fakeBin},${fakeBin}`,
        "pi-bin": fakeBin,
        "pi-trust": "explicit",
      },
      JSON_GLOBAL,
    );
    expect(code2).toBe(0);
    const lines2 = stdout().trim().split("\n").map((l) => JSON.parse(l));
    const start2 = lines2.find((e) => e.type === "message_start");
    expect(start2.trust).toBe("explicit");
    const delta2 = lines2.find((e) => e.type === "text_delta");
    const probe2 = JSON.parse(delta2.delta.replace(/^pi:/, ""));
    expect(probe2.approved).toBe(true);
  });

  it("agent record creates and updates run records with task and model", async () => {
    const dir = makeAgentDir("record-test-");
    const runId = "test-run-123";

    // Missing run-id returns 1
    stdoutChunks = []; stderrChunks = [];
    expect(await agentCmd.run(["record"], {}, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain("A run id is required");

    // Invalid status returns 1
    stdoutChunks = []; stderrChunks = [];
    expect(await agentCmd.run(["record"], { "run-id": runId, status: "invalid_status" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain('Invalid --status "invalid_status"');

    // Invalid harness returns 1
    stdoutChunks = []; stderrChunks = [];
    expect(await agentCmd.run(["record"], { "run-id": runId, harness: "invalid_harness" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain('Invalid --harness "invalid_harness"');

    // Invalid timestamps return 1
    stdoutChunks = []; stderrChunks = [];
    expect(await agentCmd.run(["record"], { "run-id": runId, started: "not-a-date" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain('Invalid --started timestamp "not-a-date"');

    stdoutChunks = []; stderrChunks = [];
    expect(await agentCmd.run(["record"], { "run-id": runId, ended: "not-a-date" }, JSON_GLOBAL)).toBe(1);
    expect(stderr()).toContain('Invalid --ended timestamp "not-a-date"');

    // 1. Initial record at session start
    stdoutChunks = [];
    const code1 = await agentCmd.run(
      ["record"],
      {
        "run-id": runId,
        parent: "parent-root-1",
        agent: dir,
        harness: "claude",
        conversation: "conv-abc",
        status: "running",
      },
      JSON_GLOBAL,
    );
    expect(code1).toBe(0);
    const jsonOutput1 = JSON.parse(stdout());
    expect(jsonOutput1.run_id).toBe(runId);
    expect(jsonOutput1.parent_id).toBe("parent-root-1");
    expect(jsonOutput1.status).toBe("running");

    const runs1 = listAgentRuns();
    const recorded1 = runs1.find((r) => r.run_id === runId);
    expect(recorded1).toBeTruthy();
    expect(recorded1?.status).toBe("running");
    expect(recorded1?.parent_id).toBe("parent-root-1");
    expect(recorded1?.conversation_id).toBe("conv-abc");
    expect(recorded1?.harness).toBe("claude");
    expect(recorded1?.ended_at).toBeNull();

    // 2. Update with message (task extraction) and model (parent preserved)
    stdoutChunks = [];
    const code2 = await agentCmd.run(
      ["record"],
      {
        "run-id": runId,
        message: "Check all findings — a question, answered in your reply only.",
        model: "claude-opus-5-5",
        status: "completed",
      },
      JSON_GLOBAL,
    );
    expect(code2).toBe(0);

    const runs2 = listAgentRuns();
    const recorded2 = runs2.find((r) => r.run_id === runId);
    expect(recorded2).toBeTruthy();
    expect(recorded2?.status).toBe("completed");
    expect(recorded2?.parent_id).toBe("parent-root-1"); // preserved
    expect(recorded2?.task).toBe("Check all findings");
    expect(recorded2?.model).toBe("claude-opus-5-5");
    expect(recorded2?.ended_at).toBeTruthy();

    // 3. Model requested vs observed precedence
    const runId2 = "test-run-model-precedence";
    stdoutChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": runId2,
          agent: dir,
          "model-requested": "opus",
          status: "running",
        },
        JSON_GLOBAL,
      ),
    ).toBe(0);
    const recModel1 = getAgentRun(runId2);
    expect(recModel1?.model).toBe("opus");
    expect(recModel1?.model_requested).toBe("opus");
    expect(recModel1?.model_observed).toBeNull();

    // Now observe actual model
    stdoutChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": runId2,
          "model-observed": "claude-opus-5-5",
          status: "completed",
        },
        JSON_GLOBAL,
      ),
    ).toBe(0);
    const recModel2 = getAgentRun(runId2);
    expect(recModel2?.model).toBe("claude-opus-5-5");
    expect(recModel2?.model_requested).toBe("opus");
    expect(recModel2?.model_observed).toBe("claude-opus-5-5");

    // 4. Self-parenting refusal
    stdoutChunks = []; stderrChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": "self-parent-run",
          parent: "self-parent-run",
        },
        JSON_GLOBAL,
      ),
    ).toBe(1);
    expect(stderr()).toContain("A run cannot be its own parent");

    // 5. Running status with ended timestamp refusal
    stdoutChunks = []; stderrChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": "running-with-ended",
          status: "running",
          ended: "2026-10-13T12:00:00.000Z",
        },
        JSON_GLOBAL,
      ),
    ).toBe(1);
    expect(stderr()).toContain("A running run cannot specify an end timestamp");

    // 6. Ended earlier than started refusal
    stdoutChunks = []; stderrChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": "ended-before-started",
          status: "completed",
          started: "2026-10-13T12:00:00.000Z",
          ended: "2026-10-13T11:00:00.000Z",
        },
        JSON_GLOBAL,
      ),
    ).toBe(1);
    expect(stderr()).toContain("End timestamp cannot be earlier than start timestamp");

    // 7. IDEASPACES_RUN_ID fallback
    process.env.IDEASPACES_RUN_ID = "env-minted-run-id";
    try {
      stdoutChunks = [];
      expect(
        await agentCmd.run(
          ["record"],
          {
            agent: dir,
            status: "running",
          },
          JSON_GLOBAL,
        ),
      ).toBe(0);
      const recEnv = getAgentRun("env-minted-run-id");
      expect(recEnv).toBeTruthy();
      expect(recEnv?.run_id).toBe("env-minted-run-id");
    } finally {
      delete process.env.IDEASPACES_RUN_ID;
    }

    // 8. Resuming a completed run (status running) clears ended_at back to null
    stdoutChunks = [];
    expect(
      await agentCmd.run(
        ["record"],
        {
          "run-id": runId,
          status: "running",
        },
        JSON_GLOBAL,
      ),
    ).toBe(0);
    const resumed = getAgentRun(runId);
    expect(resumed?.status).toBe("running");
    expect(resumed?.ended_at).toBeNull();

    // 9. Write failure surfaces as exit 1 with target path
    const unwriteableDir = join(homeDir, "read-only-config");
    mkdirSync(unwriteableDir, { recursive: true, mode: 0o400 });
    const origConfig = process.env.HOME;
    process.env.HOME = unwriteableDir;
    try {
      stdoutChunks = []; stderrChunks = [];
      const failCode = await agentCmd.run(
        ["record"],
        {
          "run-id": "fail-run",
          status: "running",
        },
        JSON_GLOBAL,
      );
      if (process.platform !== "win32" && process.getuid && process.getuid() !== 0) {
        expect(failCode).toBe(1);
        expect(stderr()).toContain("Failed to record agent run");
      }
    } finally {
      process.env.HOME = origConfig;
    }
  });

  it("agent run inherits parent_id from cached Claude session ID when env is unset", async () => {
    const parentDir = makeAgentDir("steward-parent-");
    const childDir = makeAgentDir("scout-child-");
    const fakeBin = join(childDir, "fake-claude");
    writeFileSync(join(childDir, "fake-claude.cjs"), FAKE_CLAUDE);
    writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(childDir, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(fakeBin, 0o755);

    // Simulate Claude Code SessionStart caching session id in ~/.ideaspaces/sessions/<sha256>
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(realpathSync.native(parentDir)).digest("hex").slice(0, 16);
    const sessionsDir = join(homeDir, ".ideaspaces", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, key), "steward-session-uuid-999\n");

    // 1. Direct parent directory
    const prevCwd = process.cwd();
    process.chdir(parentDir);
    try {
      stdoutChunks = [];
      const code = await agentCmd.run(
        ["run", childDir],
        {
          runtime: "claude",
          model: "sonnet",
          message: "Check child task",
          "claude-bin": fakeBin,
        },
        JSON_GLOBAL,
      );
      expect(code).toBe(0);

      const runs = listAgentRuns();
      const childRun = runs.find((r) => r.agent === realpathSync.native(childDir));
      expect(childRun).toBeTruthy();
      expect(childRun?.parent_id).toBe("steward-session-uuid-999");
    } finally {
      process.chdir(prevCwd);
    }

    // 2. Grandparent directory resolution (nested subfolder)
    const subfolder = join(parentDir, "sub", "deep");
    mkdirSync(subfolder, { recursive: true });
    process.chdir(subfolder);
    try {
      stdoutChunks = [];
      const childDir2 = makeAgentDir("scout-child2-");
      const fakeBin2 = join(childDir2, "fake-claude");
      writeFileSync(join(childDir2, "fake-claude.cjs"), FAKE_CLAUDE);
      writeFileSync(fakeBin2, `#!/bin/sh\nexec "${process.execPath}" "${join(childDir2, "fake-claude.cjs")}" "$@"\n`);
      chmodSync(fakeBin2, 0o755);

      const code = await agentCmd.run(
        ["run", childDir2],
        {
          runtime: "claude",
          model: "sonnet",
          message: "Check deep child task",
          "claude-bin": fakeBin2,
        },
        JSON_GLOBAL,
      );
      expect(code).toBe(0);

      const runs = listAgentRuns();
      const childRun2 = runs.find((r) => r.agent === realpathSync.native(childDir2));
      expect(childRun2).toBeTruthy();
      expect(childRun2?.parent_id).toBe("steward-session-uuid-999");
    } finally {
      process.chdir(prevCwd);
    }

    // 3. Environment variable takes precedence over cache
    process.chdir(parentDir);
    process.env.IDEASPACES_PARENT_ID = "explicit-env-parent-id";
    try {
      stdoutChunks = [];
      const childDir3 = makeAgentDir("scout-child3-");
      const fakeBin3 = join(childDir3, "fake-claude");
      writeFileSync(join(childDir3, "fake-claude.cjs"), FAKE_CLAUDE);
      writeFileSync(fakeBin3, `#!/bin/sh\nexec "${process.execPath}" "${join(childDir3, "fake-claude.cjs")}" "$@"\n`);
      chmodSync(fakeBin3, 0o755);

      const code = await agentCmd.run(
        ["run", childDir3],
        {
          runtime: "claude",
          model: "sonnet",
          message: "Check env precedence task",
          "claude-bin": fakeBin3,
        },
        JSON_GLOBAL,
      );
      expect(code).toBe(0);

      const runs = listAgentRuns();
      const childRun3 = runs.find((r) => r.agent === realpathSync.native(childDir3));
      expect(childRun3).toBeTruthy();
      expect(childRun3?.parent_id).toBe("explicit-env-parent-id");
    } finally {
      delete process.env.IDEASPACES_PARENT_ID;
      process.chdir(prevCwd);
    }
  });
});
