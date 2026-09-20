import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const {
  acknowledgeSubscriptionMock,
  deleteSubscriptionMock,
  listSubscriptionsMock,
  loadConfigMock,
  putSubscriptionMock,
} = vi.hoisted(() => ({
  acknowledgeSubscriptionMock: vi.fn(),
  deleteSubscriptionMock: vi.fn(),
  listSubscriptionsMock: vi.fn(),
  loadConfigMock: vi.fn(),
  putSubscriptionMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    acknowledgeSubscription: acknowledgeSubscriptionMock,
    deleteSubscription: deleteSubscriptionMock,
    listSubscriptions: listSubscriptionsMock,
    putSubscription: putSubscriptionMock,
  };
});

const { followCommand, unfollowCommand } = await import("../commands/follow.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const THREAD = "x_example";
const NODE = "n_0123456789abcdef01234567";
const row = {
  id: "fol_0123456789abcdef01234567",
  source_kind: "exchange" as const,
  source_id: THREAD,
  filter: "follow" as const,
  cursor: 0,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
};

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset().mockReturnValue(CFG);
  acknowledgeSubscriptionMock.mockReset();
  deleteSubscriptionMock.mockReset();
  listSubscriptionsMock.mockReset();
  putSubscriptionMock.mockReset();
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

describe("follow", () => {
  it("follows a Thread through the exchange source", async () => {
    putSubscriptionMock.mockResolvedValue(row);

    const code = await followCommand.run(["thread", THREAD], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(putSubscriptionMock).toHaveBeenCalledWith(CFG, { exchange_id: THREAD });
    expect(JSON.parse(stdout())).toMatchObject({ source_kind: "exchange", source_id: THREAD });
  });

  it("uses one Node source for node and repo follows", async () => {
    putSubscriptionMock.mockResolvedValue({ ...row, source_kind: "node", source_id: NODE });

    expect(await followCommand.run(["repo", NODE], {}, TEXT_GLOBAL)).toBe(0);

    expect(putSubscriptionMock).toHaveBeenCalledWith(CFG, { target_node_id: NODE });
    expect(stdout()).toContain(`Following repo ${NODE}`);
  });

  it("acknowledges an existing source and never creates one implicitly", async () => {
    listSubscriptionsMock.mockResolvedValue([row]);
    acknowledgeSubscriptionMock.mockResolvedValue({ ...row, cursor: 42 });

    const code = await followCommand.run(["thread", THREAD], { ack: "42" }, TEXT_GLOBAL);

    expect(code).toBe(0);
    expect(acknowledgeSubscriptionMock).toHaveBeenCalledWith(CFG, row.id, 42);
    expect(putSubscriptionMock).not.toHaveBeenCalled();
    expect(stdout()).toContain("through position 42");
  });

  it("unfollows by resolving the principal-owned row", async () => {
    listSubscriptionsMock.mockResolvedValue([row]);
    deleteSubscriptionMock.mockResolvedValue(undefined);

    const code = await unfollowCommand.run(["thread", THREAD], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(deleteSubscriptionMock).toHaveBeenCalledWith(CFG, row.id);
    expect(JSON.parse(stdout())).toMatchObject({ removed: true });
  });

  it("fails locally for invalid sources, absent follows, and invalid positions", async () => {
    expect(await followCommand.run(["thread", "nope"], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Invalid thread id");

    stderrChunks = [];
    expect(await followCommand.run(["thread", THREAD], { ack: "-1" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("non-negative integer");

    stderrChunks = [];
    listSubscriptionsMock.mockResolvedValue([]);
    expect(await unfollowCommand.run(["thread", THREAD], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Not following");
  });

  it("requires a person login and translates an expired session", async () => {
    loadConfigMock.mockReturnValue(null);
    expect(await followCommand.run(["thread", THREAD], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Not logged in");

    stderrChunks = [];
    loadConfigMock.mockReturnValue(CFG);
    putSubscriptionMock.mockRejectedValue(new UnauthorizedError("401"));
    expect(await followCommand.run(["thread", THREAD], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Session expired");
  });
});
