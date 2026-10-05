import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  createAccessRequestMock,
  listAccessRequestsMock,
  listIncomingAccessRequestsMock,
  getAccessRequestMock,
  approveAccessRequestMock,
  denyAccessRequestMock,
  cancelAccessRequestMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  createAccessRequestMock: vi.fn(),
  listAccessRequestsMock: vi.fn(),
  listIncomingAccessRequestsMock: vi.fn(),
  getAccessRequestMock: vi.fn(),
  approveAccessRequestMock: vi.fn(),
  denyAccessRequestMock: vi.fn(),
  cancelAccessRequestMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    createAccessRequest: createAccessRequestMock,
    listAccessRequests: listAccessRequestsMock,
    listIncomingAccessRequests: listIncomingAccessRequestsMock,
    getAccessRequest: getAccessRequestMock,
    approveAccessRequest: approveAccessRequestMock,
    denyAccessRequest: denyAccessRequestMock,
    cancelAccessRequest: cancelAccessRequestMock,
  };
});

const { requestCommand } = await import("../commands/request.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const TARGET = "n_0123456789abcdef01234567";
const REQUEST_ID = "r_0123456789abcdef";

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset().mockReturnValue(CFG);
  createAccessRequestMock.mockReset();
  listAccessRequestsMock.mockReset();
  listIncomingAccessRequestsMock.mockReset();
  getAccessRequestMock.mockReset();
  approveAccessRequestMock.mockReset();
  denyAccessRequestMock.mockReset();
  cancelAccessRequestMock.mockReset();
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

describe("ideaspaces request", () => {
  it("asks for Viewer access on a target node", async () => {
    createAccessRequestMock.mockResolvedValue({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "explore",
      reason: "Need to review finding",
      state: "pending",
      expires_at: "2026-10-12T00:00:00Z",
      created_at: "2026-10-05T00:00:00Z",
    });

    const code = await requestCommand.run(
      [TARGET],
      { grade: "viewer", reason: "Need to review finding" },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(createAccessRequestMock).toHaveBeenCalledWith(CFG, TARGET, {
      grade: "explore",
      reason: "Need to review finding",
    });
    expect(stdout()).toContain("Requested Viewer (explore) access to n_0123456789abcdef01234567");
    expect(stdout()).toContain(`(request ${REQUEST_ID})`);
    expect(stdout()).toContain("The owner will decide.");
  });

  it("asks for Editor access using ask subcommand and --json output", async () => {
    createAccessRequestMock.mockResolvedValue({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "collaborate",
      state: "pending",
      expires_at: "2026-10-12T00:00:00Z",
      created_at: "2026-10-05T00:00:00Z",
    });

    const code = await requestCommand.run(
      ["ask", TARGET],
      { grade: "editor" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(createAccessRequestMock).toHaveBeenCalledWith(CFG, TARGET, {
      grade: "collaborate",
      reason: undefined,
    });
    expect(JSON.parse(stdout())).toMatchObject({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "collaborate",
    });
  });

  it("refuses an invalid target Node identifier or invalid grade", async () => {
    let code = await requestCommand.run(["not_a_node_id"], {}, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Invalid target Node ID");

    code = await requestCommand.run([TARGET], { grade: "invalid_grade" }, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Invalid --grade");
  });

  it("lists incoming requests for managers", async () => {
    listIncomingAccessRequestsMock.mockResolvedValue({
      requests: [
        {
          id: REQUEST_ID,
          target_node_id: TARGET,
          requested_grade: "explore",
          requester: "person:user_2",
          position: 1,
          reason: "Please give access",
          state: "pending",
          expires_at: "2026-10-12T00:00:00Z",
          created_at: "2026-10-05T00:00:00Z",
        },
      ],
    });

    const code = await requestCommand.run(["list"], {}, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(stdout()).toContain("Incoming access requests (1):");
    expect(stdout()).toContain(`${REQUEST_ID}  Access request for ${TARGET}`);
    expect(stdout()).toContain("person:user_2 requests Viewer (explore)");
    expect(stdout()).toContain("Reason: Please give access");
  });

  it("lists caller's own requests with --mine", async () => {
    listAccessRequestsMock.mockResolvedValue({
      requests: [
        {
          id: REQUEST_ID,
          target_node_id: TARGET,
          requested_grade: "explore",
          state: "pending",
          expires_at: "2026-10-12T00:00:00Z",
          created_at: "2026-10-05T00:00:00Z",
        },
      ],
    });

    const code = await requestCommand.run(["list"], { mine: true }, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(stdout()).toContain("Your access requests (1):");
    expect(stdout()).toContain(`${REQUEST_ID}  Access request for ${TARGET}`);
    expect(stdout()).toContain("Requested: Viewer (explore) · State: pending");
  });

  it("approves an incoming request", async () => {
    approveAccessRequestMock.mockResolvedValue({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "explore",
      approved_grade: "explore",
      state: "approved",
      changed: true,
      expires_at: "2026-10-12T00:00:00Z",
      created_at: "2026-10-05T00:00:00Z",
      approved_at: "2026-10-05T01:00:00Z",
    });

    const code = await requestCommand.run(["approve", REQUEST_ID], {}, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(approveAccessRequestMock).toHaveBeenCalledWith(CFG, REQUEST_ID, { grade: undefined });
    expect(stdout()).toContain(`Approved Viewer (explore) access for request ${REQUEST_ID} (${TARGET}).`);
  });

  it("declines an incoming request", async () => {
    denyAccessRequestMock.mockResolvedValue({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "explore",
      state: "denied",
      changed: false,
      expires_at: "2026-10-12T00:00:00Z",
      created_at: "2026-10-05T00:00:00Z",
      denied_at: "2026-10-05T01:00:00Z",
    });

    const code = await requestCommand.run(["decline", REQUEST_ID], {}, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(denyAccessRequestMock).toHaveBeenCalledWith(CFG, REQUEST_ID);
    expect(stdout()).toContain(`Declined request ${REQUEST_ID} for ${TARGET}.`);
  });

  it("cancels caller's own request", async () => {
    cancelAccessRequestMock.mockResolvedValue({
      id: REQUEST_ID,
      target_node_id: TARGET,
      requested_grade: "explore",
      state: "cancelled",
      expires_at: "2026-10-12T00:00:00Z",
      created_at: "2026-10-05T00:00:00Z",
      cancelled_at: "2026-10-05T01:00:00Z",
    });

    const code = await requestCommand.run(["cancel", REQUEST_ID], {}, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(cancelAccessRequestMock).toHaveBeenCalledWith(CFG, REQUEST_ID);
    expect(stdout()).toContain(`Cancelled request ${REQUEST_ID}.`);
  });
});
