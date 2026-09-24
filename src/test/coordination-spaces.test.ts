import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchCoordinationSpacesMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchCoordinationSpacesMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchCoordinationSpaces: fetchCoordinationSpacesMock,
  };
});

const { spacesCommand } = await import("../commands/spaces.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset().mockReturnValue(CFG);
  fetchCoordinationSpacesMock.mockReset();
  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("ideaspaces spaces command", () => {
  it("requires login and maps an expired session", async () => {
    loadConfigMock.mockReturnValue(null);
    expect(await spacesCommand.run([], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Not logged in. Run `ideaspaces login`.");

    stderrChunks = [];
    loadConfigMock.mockReturnValue(CFG);
    fetchCoordinationSpacesMock.mockRejectedValue(new UnauthorizedError("401"));
    expect(await spacesCommand.run([], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Session expired. Run `ideaspaces login`.");
  });

  it("lists authorized coordination spaces with details", async () => {
    fetchCoordinationSpacesMock.mockResolvedValue({
      spaces: [
        {
          kind: "coordination_space",
          node_id: "n_space_1",
          name: "Engineering",
          summary: "Team engineering space",
          status: "active",
          lifecycle: "active",
          owner: "person:user_1",
          relationship: "owner",
          actions: ["read", "write", "admin"],
          canonical_url: "/coordination-spaces/n_space_1",
        },
      ],
      default_space_node_id: "n_space_1",
    });

    const code = await spacesCommand.run([], {}, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(fetchCoordinationSpacesMock).toHaveBeenCalledWith(CFG, {
      attached_to: undefined,
      include_dormant: undefined,
    });
    expect(stdout()).toContain("Engineering (n_space_1) · active · owner [read, write, admin]");
    expect(stdout()).toContain("Team engineering space");

    // JSON output
    stdoutChunks = [];
    const codeJson = await spacesCommand.run([], {}, JSON_GLOBAL);
    expect(codeJson).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      spaces: [{ node_id: "n_space_1", name: "Engineering" }],
      default_space_node_id: "n_space_1",
    });
  });

  it("passes --attached-to and --include-dormant flags", async () => {
    fetchCoordinationSpacesMock.mockResolvedValue({ spaces: [] });

    const code = await spacesCommand.run(
      ["list"],
      { "attached-to": "repo:n_0123456789abcdef01234567", "include-dormant": true },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(fetchCoordinationSpacesMock).toHaveBeenCalledWith(CFG, {
      attached_to: "repo:n_0123456789abcdef01234567",
      include_dormant: true,
    });
    expect(stdout()).toContain("No coordination spaces found.");
  });

  it("refuses unexpected positional arguments", async () => {
    const code = await spacesCommand.run(["unknown_subcommand"], {}, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage: ideaspaces spaces");
  });
});
