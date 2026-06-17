import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAgentsMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAgents: fetchAgentsMock };
});

const { agentsCommand } = await import("../commands/agents.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  fetchAgentsMock.mockReset();
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

describe("agents", () => {
  it("lists the caller's agents as JSON", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchAgentsMock.mockResolvedValue([
      {
        owner_actor_node_id: "o1",
        node_id: "a1",
        identity: "agent:a1",
        name: "Keeper",
        summary: "",
        can_use: true,
        is_default: true,
      },
    ]);

    const code = await agentsCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchAgentsMock).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(JSON.parse(stdout())).toMatchObject({ agents: [{ node_id: "a1", name: "Keeper" }] });
  });

  it("scopes by --owner", async () => {
    loadConfigMock.mockReturnValue(CFG);
    fetchAgentsMock.mockResolvedValue([]);

    const code = await agentsCommand.run([], { owner: "hostname:acme.com" }, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchAgentsMock).toHaveBeenCalledWith(expect.anything(), "hostname:acme.com");
  });

  it("errors and does not fetch when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    const code = await agentsCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
    expect(fetchAgentsMock).not.toHaveBeenCalled();
  });
});
