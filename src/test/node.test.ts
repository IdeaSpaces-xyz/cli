import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchNodeMock, fetchNodeHistoryMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchNodeMock: vi.fn(),
  fetchNodeHistoryMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchNode: fetchNodeMock, fetchNodeHistory: fetchNodeHistoryMock };
});

const { nodeCommand } = await import("../commands/node.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  fetchNodeMock.mockReset();
  fetchNodeHistoryMock.mockReset();
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

describe("node get", () => {
  it("resolves a node to its detail as JSON", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeMock.mockResolvedValue({
      node_id: "n1",
      name: "Space",
      path: "core/space.md",
      content: "# Space",
      node_type: "note",
    });

    const code = await nodeCommand.run(["get", "repo_abc", "n1"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchNodeMock).toHaveBeenCalledWith(CFG, "repo_abc", "n1");
    expect(JSON.parse(stdout())).toMatchObject({ node_id: "n1", path: "core/space.md" });
  });

  it("requires a repo id and node id", async () => {
    loadConfigMock.mockReturnValue(CFG);
    const code = await nodeCommand.run(["get", "repo_abc"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(fetchNodeMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown subcommand", async () => {
    const code = await nodeCommand.run(["frobnicate", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });

  it("errors and does not fetch when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await nodeCommand.run(["get", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
    expect(fetchNodeMock).not.toHaveBeenCalled();
  });

  it("surfaces session-expired when the API returns 401", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeMock.mockRejectedValue(new UnauthorizedError("401"));
    const code = await nodeCommand.run(["get", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
  });

  it("surfaces a generic error (e.g. 404 / network)", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeMock.mockRejectedValue(new Error("404: node not found"));
    const code = await nodeCommand.run(["get", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("node not found");
  });

  it("human output prefers name_display and previews the content", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeMock.mockResolvedValue({
      node_id: "n1",
      name: "space",
      name_display: "The Space",
      path: "core/space.md",
      content: "# Space\n\nKnowledge compounds here.",
      node_type: "note",
    });

    const code = await nodeCommand.run(["get", "repo_abc", "n1"], {}, TEXT_GLOBAL);

    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain("The Space (core/space.md)");
    expect(out).toContain("Knowledge compounds here.");
  });
});

describe("node history (hosted)", () => {
  it("fetches node history from API as JSON", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeHistoryMock.mockResolvedValue({
      node_id: "n1",
      path: "notes/design.md",
      created: "2026-10-01 12:00:00 +0000",
      total: 26,
      history: [
        {
          sha: "480e48b645b238382d61a357fde1ec50ef551fa1",
          message: "Revise design note for change",
          date: "2026-10-12 10:45:00 +0000",
          author: "person:user_1",
          op: "update",
          conversation_id: "c_abc123",
          turn: 5,
          co_authored_by: ["person:alice <person:alice@ideaspaces.xyz>"],
          change_id: "chg_update_456",
        },
      ],
      authors: {
        "person:user_1": {
          kind: "person",
          name: "Alice",
          username: "alice",
        },
      },
    });

    const code = await nodeCommand.run(["history", "repo_abc", "n1"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchNodeHistoryMock).toHaveBeenCalledWith(CFG, "repo_abc", "n1");
    expect(JSON.parse(stdout())).toMatchObject({
      node_id: "n1",
      path: "notes/design.md",
      created: "2026-10-01 12:00:00 +0000",
      total: 26,
      history: [
        {
          sha: "480e48b645b238382d61a357fde1ec50ef551fa1",
          change_id: "chg_update_456",
          co_authored_by: ["person:alice <person:alice@ideaspaces.xyz>"],
        },
      ],
    });
  });

  it("errors when hosted history is requested without login", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await nodeCommand.run(["history", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
    expect(fetchNodeHistoryMock).not.toHaveBeenCalled();
  });

  it("surfaces session-expired when hosted history returns 401", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeHistoryMock.mockRejectedValue(new UnauthorizedError("401"));
    const code = await nodeCommand.run(["history", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
  });

  it("formats human output for hosted history and resolves authors map names", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeHistoryMock.mockResolvedValue({
      node_id: "n1",
      path: "notes/design.md",
      created: "2026-10-01 12:00:00 +0000",
      total: 1,
      history: [
        {
          sha: "480e48b645b238382d61a357fde1ec50ef551fa1",
          message: "Revise design note",
          date: "2026-10-12 10:45:00 +0000",
          author: "person:user_1",
          change_id: "chg_update_456",
        },
      ],
      authors: {
        "person:user_1": {
          kind: "person",
          name: "Alice",
          username: "alice",
        },
      },
    });

    const code = await nodeCommand.run(["history", "repo_abc", "n1"], {}, TEXT_GLOBAL);

    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain("notes/design.md (1 commit, created 2026-10-01 12:00:00 +0000)");
    expect(out).toContain("480e48b6 2026-10-12 Alice: Revise design note [chg_update_456]");
  });

  it("surfaces API errors when hosted history fails", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchNodeHistoryMock.mockRejectedValue(new Error("404: Node not found"));
    const code = await nodeCommand.run(["history", "repo_abc", "n1"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Node not found");
  });
});
