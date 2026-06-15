import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  createConversationMock,
  listParticipantsMock,
  addParticipantMock,
  removeParticipantMock,
  fetchRepoMembersMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  createConversationMock: vi.fn(),
  listParticipantsMock: vi.fn(),
  addParticipantMock: vi.fn(),
  removeParticipantMock: vi.fn(),
  fetchRepoMembersMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    createConversation: createConversationMock,
    listParticipants: listParticipantsMock,
    addParticipant: addParticipantMock,
    removeParticipant: removeParticipantMock,
    fetchRepoMembers: fetchRepoMembersMock,
  };
});

const { conversationCommand } = await import("../commands/conversation.js");
const { UnauthorizedError } = await import("../auth/api.js");

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
  listParticipantsMock.mockReset();
  addParticipantMock.mockReset();
  removeParticipantMock.mockReset();
  fetchRepoMembersMock.mockReset();
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

const participant = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  process_node_id: "n_conv",
  participant: "person:bob",
  role: "member",
  joined_at: null,
  joined_via: null,
  revoked_at: null,
  ...over,
});

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

  it("requires a repo id", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["new"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

describe("conversation add", () => {
  it("normalizes a bare username to a person principal", async () => {
    loadConfigMock.mockReturnValue(CFG);
    addParticipantMock.mockResolvedValue(participant({ participant: "person:alice" }));
    const code = await conversationCommand.run(["add", "repo_abc", "c1", "alice"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(addParticipantMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", "c1", "person:alice", "member");
  });

  it("passes a prefixed principal through unchanged (e.g. an agent)", async () => {
    loadConfigMock.mockReturnValue(CFG);
    addParticipantMock.mockResolvedValue(participant({ participant: "agent:n_x" }));
    await conversationCommand.run(["add", "repo_abc", "c1", "agent:n_x"], {}, JSON_GLOBAL);
    expect(addParticipantMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", "c1", "agent:n_x", "member");
  });

  it("honors --role reader", async () => {
    loadConfigMock.mockReturnValue(CFG);
    addParticipantMock.mockResolvedValue(participant({ role: "reader" }));
    await conversationCommand.run(["add", "repo_abc", "c1", "bob"], { role: "reader" }, JSON_GLOBAL);
    expect(addParticipantMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", "c1", "person:bob", "reader");
  });

  it("rejects an invalid --role without calling the API", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["add", "repo_abc", "c1", "bob"], { role: "admin" }, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("member");
    expect(addParticipantMock).not.toHaveBeenCalled();
  });

  it("requires repo, conversation, and actor", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await conversationCommand.run(["add", "repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });

  it("maps a 401 to session-expired", async () => {
    loadConfigMock.mockReturnValue(CFG);
    addParticipantMock.mockRejectedValue(new UnauthorizedError("401"));
    const code = await conversationCommand.run(["add", "repo_abc", "c1", "alice"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
  });
});

describe("conversation remove", () => {
  it("removes by normalized principal", async () => {
    loadConfigMock.mockReturnValue(CFG);
    removeParticipantMock.mockResolvedValue(participant({ revoked_at: "2026-06-15T00:00:00Z" }));
    const code = await conversationCommand.run(["remove", "repo_abc", "c1", "alice"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(removeParticipantMock).toHaveBeenCalledWith(expect.anything(), "repo_abc", "c1", "person:alice");
  });
});

describe("conversation participants", () => {
  it("lists the roster (human)", async () => {
    loadConfigMock.mockReturnValue(CFG);
    listParticipantsMock.mockResolvedValue({
      participants: [
        participant({ participant: "person:alice", role: "owner", id: null }),
        participant({ participant: "person:bob", role: "member" }),
      ],
    });
    const code = await conversationCommand.run(["participants", "repo_abc", "c1"], {}, HUMAN_GLOBAL);
    expect(code).toBe(0);
    expect(stdout()).toContain("person:bob — member");
  });

  it("shows an empty-state hint", async () => {
    loadConfigMock.mockReturnValue(CFG);
    listParticipantsMock.mockResolvedValue({ participants: [] });
    await conversationCommand.run(["participants", "repo_abc", "c1"], {}, HUMAN_GLOBAL);
    expect(stdout()).toContain("No participants");
  });
});

describe("conversation members", () => {
  it("lists repo members as add candidates", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchRepoMembersMock.mockResolvedValue([{ user_id: 1, username: "alice", email: null, role: "OWNER" }]);
    const code = await conversationCommand.run(["members", "repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(JSON.parse(stdout()).members[0].username).toBe("alice");
  });
});

describe("conversation — auth", () => {
  it("errors when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await conversationCommand.run(["participants", "repo_abc", "c1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
  });
});
