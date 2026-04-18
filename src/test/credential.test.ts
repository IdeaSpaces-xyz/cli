import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
}));

const { credentialCommand } = await import("../commands/credential.js");

const GLOBAL: GlobalFlags = {
  json: false,
  quiet: false,
  yes: false,
  help: false,
};

// ─── Stdin / stdout harness ─────────────────────────────────────────────

function mockStdin(input: string): void {
  const stream = Readable.from([Buffer.from(input, "utf-8")]);
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get: () => stream,
  });
}

let stdoutChunks: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  stdoutChunks = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  loadConfigMock.mockReset();
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalWrite) = originalWrite;
});

function capturedStdout(): string {
  return stdoutChunks.join("");
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("credential command — get", () => {
  it("returns username + password for git.ideaspaces.xyz when logged in", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_test",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });

    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\n\n");
    const code = await credentialCommand.run(["get"], {}, GLOBAL);

    expect(code).toBe(0);
    const out = capturedStdout();
    expect(out).toContain("username=token");
    expect(out).toContain("password=sk_sw_test");
  });

  it("honours git-provided username if present", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_abc",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });

    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\nusername=alice\n\n");
    await credentialCommand.run(["get"], {}, GLOBAL);

    const out = capturedStdout();
    expect(out).toContain("username=alice");
    expect(out).toContain("password=sk_sw_abc");
  });

  it("returns nothing for non-ideaspaces hosts", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_test",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });

    mockStdin("protocol=https\nhost=github.com\n\n");
    const code = await credentialCommand.run(["get"], {}, GLOBAL);

    expect(code).toBe(0);
    expect(capturedStdout()).toBe("");
  });

  it("returns nothing when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\n\n");
    const code = await credentialCommand.run(["get"], {}, GLOBAL);

    expect(code).toBe(0);
    expect(capturedStdout()).toBe("");
  });

  it("handles git.ideaspaces.localhost (dev)", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_dev",
      apiUrl: "http://localhost:8000",
      repo: "",
    });

    mockStdin("protocol=http\nhost=git.ideaspaces.localhost\n\n");
    await credentialCommand.run(["get"], {}, GLOBAL);

    expect(capturedStdout()).toContain("password=sk_sw_dev");
  });
});

describe("credential command — store / erase", () => {
  it("store is a no-op", async () => {
    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\npassword=ignored\n\n");
    const code = await credentialCommand.run(["store"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(capturedStdout()).toBe("");
    // loadConfig must not be called (we don't overwrite our credentials)
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("erase is a no-op", async () => {
    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\n\n");
    const code = await credentialCommand.run(["erase"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(capturedStdout()).toBe("");
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});

describe("credential command — unknown action", () => {
  it("returns non-zero and produces no output", async () => {
    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\n\n");
    const code = await credentialCommand.run(["gibberish"], {}, GLOBAL);
    expect(code).not.toBe(0);
    expect(capturedStdout()).toBe("");
  });
});
