import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
}));

const { whoamiCommand } = await import("../commands/whoami.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  stdoutChunks = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalWrite) = originalWrite;
});

function capturedStdout(): string {
  return stdoutChunks.join("");
}

describe("whoami", () => {
  it("reports logged in with the API url, never the key, as JSON", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key" });

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const out = JSON.parse(capturedStdout());
    expect(out).toEqual({ logged_in: true, api_url: "https://api.example.test" });
    expect(capturedStdout()).not.toContain("secret-key");
  });

  it("reports not logged in when there are no credentials", async () => {
    loadConfigMock.mockReturnValue(null);

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(capturedStdout())).toEqual({ logged_in: false });
  });

  it("prints human-readable text without --json", async () => {
    loadConfigMock.mockReturnValue(null);

    await whoamiCommand.run([], {}, HUMAN_GLOBAL);

    expect(capturedStdout()).toContain("Not logged in");
  });

  it("prints the API url in human-readable text when logged in", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key" });

    await whoamiCommand.run([], {}, HUMAN_GLOBAL);

    expect(capturedStdout()).toContain("Logged in to https://api.example.test");
    expect(capturedStdout()).not.toContain("secret-key");
  });
});
