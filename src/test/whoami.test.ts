import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, loadStoredCredentialsMock, saveCredentialsMock, fetchAuthMeMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadStoredCredentialsMock: vi.fn(),
  saveCredentialsMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
  loadStoredCredentials: loadStoredCredentialsMock,
  saveCredentials: saveCredentialsMock,
}));

vi.mock("../auth/api.js", () => ({
  fetchAuthMe: fetchAuthMeMock,
}));

const { whoamiCommand } = await import("../commands/whoami.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  loadStoredCredentialsMock.mockReset();
  saveCredentialsMock.mockReset();
  fetchAuthMeMock.mockReset();
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
  it("reports logged in with the API url and cached handle, never the key, as JSON", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key", username: "ernests_s" });

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const out = JSON.parse(capturedStdout());
    expect(out).toEqual({ logged_in: true, api_url: "https://api.example.test", username: "ernests_s" });
    expect(capturedStdout()).not.toContain("secret-key");
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
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

  it("names the account in human-readable text when logged in", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key", username: "ernests_s" });

    await whoamiCommand.run([], {}, HUMAN_GLOBAL);

    expect(capturedStdout()).toContain("Logged in to https://api.example.test as @ernests_s");
    expect(capturedStdout()).not.toContain("secret-key");
  });

  it("backfills and caches the handle when the credentials predate it", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key" });
    loadStoredCredentialsMock.mockReturnValue({ api_url: "https://api.example.test", api_key: "secret-key" });
    fetchAuthMeMock.mockResolvedValue({ username: "ernests_s", repos: [] });

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(capturedStdout())).toEqual({ logged_in: true, api_url: "https://api.example.test", username: "ernests_s" });
    expect(saveCredentialsMock).toHaveBeenCalledWith({ api_url: "https://api.example.test", api_key: "secret-key", username: "ernests_s" });
  });

  it("skips the backfill for env-key auth with no credentials file, staying instant", async () => {
    // IS_API_KEY / CI auth: loadConfig has no cached handle and there's no
    // on-disk file to cache one into — whoami must not round-trip on every call.
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "env-key" });
    loadStoredCredentialsMock.mockReturnValue(null);

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(capturedStdout())).toEqual({ logged_in: true, api_url: "https://api.example.test", username: null });
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
    expect(saveCredentialsMock).not.toHaveBeenCalled();
  });

  it("stays logged in without a handle when the backfill is offline", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "secret-key" });
    loadStoredCredentialsMock.mockReturnValue({ api_url: "https://api.example.test", api_key: "secret-key" });
    fetchAuthMeMock.mockRejectedValue(new Error("network down"));

    const code = await whoamiCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(capturedStdout())).toEqual({ logged_in: true, api_url: "https://api.example.test", username: null });
    expect(saveCredentialsMock).not.toHaveBeenCalled();
  });
});
