import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  createConversationMock,
  streamConversationMessageMock,
  getConversationMock,
  cancelConversationTurnMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  createConversationMock: vi.fn(),
  streamConversationMessageMock: vi.fn(),
  getConversationMock: vi.fn(),
  cancelConversationTurnMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    createConversation: createConversationMock,
    streamConversationMessage: streamConversationMessageMock,
    getConversation: getConversationMock,
    cancelConversationTurn: cancelConversationTurnMock,
  };
});

const { makeConversationCommand } = await import("../commands/conversation.js");
const { UnauthorizedError } = await import("../auth/api.js");

// These tests exercise only the remote paths; the injected local (Pi) ops are a
// no-op stub that never runs (no test passes `--local`).
const stubLocalOps = { send: async () => 0, createNew: () => 0, get: () => 0, list: () => 0 };
const conversationCommand = makeConversationCommand(stubLocalOps);

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  createConversationMock.mockReset();
  streamConversationMessageMock.mockReset();
  getConversationMock.mockReset();
  cancelConversationTurnMock.mockReset();
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
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("conversation — dispatch", () => {
  it("rejects an unknown subcommand with usage", async () => {
    const code = await conversationCommand.run(["frobnicate"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });

  it("rejects a missing subcommand with usage", async () => {
    const code = await conversationCommand.run([], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });

  it("advertises only private conversation operations", () => {
    expect(conversationCommand.description).toBe("Create and run a private conversation");
    expect(conversationCommand.usage).toContain("<new|send|get|cancel>");
    expect(conversationCommand.usage).not.toMatch(/participants|members|add|remove/);
    expect(conversationCommand.examples?.join("\n")).not.toMatch(
      /conversation (participants|members|add|remove)/,
    );
  });

  it.each(["members", "participants", "add", "remove"])(
    "rejects retired %s locally with migration guidance",
    async (sub) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const code = await conversationCommand.run([sub, "repo_abc", "c1", "alice"], {}, JSON_GLOBAL);
        expect(code).toBe(1);
        expect(stderr()).toContain(`conversation ${sub}`);
        expect(stderr()).toContain("Conversations are private");
        expect(stderr()).toContain("ideaspaces share person <email|@handle>");
        expect(stderr()).toContain("ideaspaces share team <hostname>");
        expect(loadConfigMock).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
});

describe("conversation new", () => {
  it("sends the name when given", async () => {
    loadConfigMock.mockReturnValue(CFG);
    createConversationMock.mockResolvedValue({ conversation_id: "c9", name: "Kickoff" });
    const code = await conversationCommand.run(["new", "repo_abc"], { name: "Kickoff" }, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(createConversationMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", { name: "Kickoff" });
    expect(JSON.parse(stdout()).conversation_id).toBe("c9");
  });

  it("sends an empty body without --name (server fills defaults)", async () => {
    loadConfigMock.mockReturnValue(CFG);
    createConversationMock.mockResolvedValue({ conversation_id: "c9", name: "New conversation" });
    await conversationCommand.run(["new", "repo_abc"], {}, JSON_GLOBAL);
    expect(createConversationMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", {});
  });

  it("passes the chosen agent through to create", async () => {
    loadConfigMock.mockReturnValue(CFG);
    createConversationMock.mockResolvedValue({ conversation_id: "c9", name: "New conversation" });
    await conversationCommand.run(["new", "repo_abc"], { agent: "agent_xyz" }, JSON_GLOBAL);
    expect(createConversationMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", {
      agent_node_id: "agent_xyz",
    });
  });

  it("requires a repo id", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["new"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

describe("conversation send", () => {
  it("emits one JSON line per streamed event", async () => {
    loadConfigMock.mockReturnValue(CFG);
    streamConversationMessageMock.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "Hi" };
      yield { type: "turn_complete", result: { workspace: { created: ["n1"] } } };
    });
    const code = await conversationCommand.run(
      ["send", "repo_abc", "c1"],
      { message: "hey" },
      JSON_GLOBAL,
    );
    expect(code).toBe(0);
    expect(stdout()).toBe(
      '{"type":"text_delta","delta":"Hi"}\n' +
        '{"type":"turn_complete","result":{"workspace":{"created":["n1"]}}}\n',
    );
  });

  it("passes model_tier and thinking through to the stream body", async () => {
    loadConfigMock.mockReturnValue(CFG);
    streamConversationMessageMock.mockImplementation(async function* () {
      // no events
    });
    await conversationCommand.run(
      ["send", "repo_abc", "c1"],
      { message: "hey", model: "opus", thinking: true },
      JSON_GLOBAL,
    );
    expect(streamConversationMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "repo_abc",
      "c1",
      { message: "hey", model_tier: "opus", thinking: true },
      expect.anything(),
    );
  });

  it("requires a --message", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["send", "repo_abc", "c1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("message is required");
    expect(streamConversationMessageMock).not.toHaveBeenCalled();
  });

  it("surfaces a stream error", async () => {
    loadConfigMock.mockReturnValue(CFG);
    streamConversationMessageMock.mockImplementation(async function* () {
      throw new Error("POST … → 402: out of credits");
    });
    const code = await conversationCommand.run(
      ["send", "repo_abc", "c1"],
      { message: "hey" },
      JSON_GLOBAL,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("402");
  });

  it("on a cancel signal, aborts the stream and cancels the server turn", async () => {
    loadConfigMock.mockReturnValue(CFG);
    cancelConversationTurnMock.mockResolvedValue({ status: "cancelling", conversation_id: "c1" });

    // Capture the SIGINT handler the command registers so we can fire it
    // directly — raising a real signal could be intercepted by the test runner.
    const onSpy = vi.spyOn(process, "on");
    streamConversationMessageMock.mockImplementation(
      // eslint-disable-next-line require-yield
      async function* (_c: unknown, _r: string, _cv: string, _b: unknown, signal: AbortSignal) {
        yield { type: "text_delta", delta: "a" };
        const reg = onSpy.mock.calls.find(([sig]) => sig === "SIGINT");
        (reg?.[1] as (() => void) | undefined)?.();
        expect(signal.aborted).toBe(true);
      },
    );

    const code = await conversationCommand.run(
      ["send", "repo_abc", "c1"],
      { message: "hey" },
      JSON_GLOBAL,
    );
    expect(code).toBe(0);
    expect(cancelConversationTurnMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", "c1");
    onSpy.mockRestore();
  });
});

describe("conversation get", () => {
  it("renders the history (human)", async () => {
    loadConfigMock.mockReturnValue(CFG);
    getConversationMock.mockResolvedValue({
      conversation_id: "c1",
      repo_id: "repo_abc",
      name: "Kickoff",
      history: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hi — how can I help?" },
      ],
      active_turn: null,
    });
    const code = await conversationCommand.run(["get", "repo_abc", "c1"], {}, HUMAN_GLOBAL);
    expect(code).toBe(0);
    expect(stdout()).toContain("assistant: hi — how can I help?");
  });

  it("empty-state when there are no messages", async () => {
    loadConfigMock.mockReturnValue(CFG);
    getConversationMock.mockResolvedValue({
      conversation_id: "c1",
      repo_id: "repo_abc",
      name: "Empty",
      history: [],
      active_turn: null,
    });
    await conversationCommand.run(["get", "repo_abc", "c1"], {}, HUMAN_GLOBAL);
    expect(stdout()).toContain("No messages yet");
  });

  it("requires repo and conversation", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["get", "repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(getConversationMock).not.toHaveBeenCalled();
  });
});

describe("conversation cancel", () => {
  it("cancels the active turn", async () => {
    loadConfigMock.mockReturnValue(CFG);
    cancelConversationTurnMock.mockResolvedValue({ status: "cancelling", conversation_id: "c1" });
    const code = await conversationCommand.run(["cancel", "repo_abc", "c1"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(JSON.parse(stdout()).status).toBe("cancelling");
  });

  it("requires repo and conversation", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["cancel", "repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(cancelConversationTurnMock).not.toHaveBeenCalled();
  });
});

describe("conversation — auth", () => {
  it("errors when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await conversationCommand.run(["get", "repo_abc", "c1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
  });
});
