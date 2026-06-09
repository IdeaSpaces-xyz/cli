import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchConversationsMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchConversationsMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchConversations: fetchConversationsMock };
});

const { conversationsCommand } = await import("../commands/conversations.js");
const { UnauthorizedError } = await import("../auth/api.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  fetchConversationsMock.mockReset();
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

describe("conversations", () => {
  it("lists a repo's conversations as JSON", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchConversationsMock.mockResolvedValue({
      total: 1,
      conversations: [
        {
          conversation_id: "c1",
          name: "Kickoff",
          summary: "first chat",
          message_count: 3,
          status: "idle",
          updated_at: "2026-06-09T00:00:00Z",
        },
      ],
    });

    const code = await conversationsCommand.run(["repo_abc"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const data = JSON.parse(stdout());
    expect(data.repo_id).toBe("repo_abc");
    expect(data.conversations[0]).toMatchObject({ conversation_id: "c1", name: "Kickoff", message_count: 3 });
    expect(fetchConversationsMock).toHaveBeenCalledWith(expect.anything(), "repo_abc");
  });

  it("requires a repo id", async () => {
    const code = await conversationsCommand.run([], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });

  it("errors when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await conversationsCommand.run(["repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
  });

  it("maps a 401 to a session-expired message", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchConversationsMock.mockRejectedValue(new UnauthorizedError("401"));
    const code = await conversationsCommand.run(["repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
  });

  it("shows an empty-state hint in human mode", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchConversationsMock.mockResolvedValue({ total: 0, conversations: [] });
    const code = await conversationsCommand.run(["repo_abc"], {}, HUMAN_GLOBAL);
    expect(code).toBe(0);
    expect(stdout()).toContain("No conversations");
  });
});
