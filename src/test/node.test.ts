import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchNodeMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchNodeMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchNode: fetchNodeMock };
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
