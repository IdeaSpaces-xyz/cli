import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAuthMe, optionalAuthRead } from "../auth/api.js";
import {
  deleteCredentials, HostAuthRefusal, loadConfig, loadOptionalAuthConfig, loadStoredCredentials, peekConfig, saveCredentials, withCredentialsLock,
} from "../auth/credentials.js";
import { resolveSessionConfig, signOut } from "../auth/client-session.js";
import { credentialCommand } from "../commands/credential.js";
import { doctorCommand } from "../commands/doctor.js";
import { loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/power/logout.js";
import { reposCommand } from "../commands/repos.js";
import { whoamiCommand } from "../commands/whoami.js";
import { HostTokenError } from "../auth/host-token.js";
import { handleError } from "../errors.js";
import { createOutput } from "../output.js";
import type { GlobalFlags } from "../types.js";

// An app that keeps its own sign-in runs the CLI with IDEASPACES_AUTH=host. A terminal sign-in
// (credentials.json, with a rotating session) and an IS_API_KEY sit beside it: neither is used.
const HUMAN: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const JSON_FLAGS: GlobalFlags = { ...HUMAN, json: true };
const STORED = {
  api_url: "https://api.ideaspaces.test",
  api_key: "terminal-access-token",
  username: "person",
  session: { id: "sess_1", install_id: "install_1", refresh_token: "terminal-refresh-token", expires_at: 1, refresh_expires_at: Date.now() + 86_400_000 },
};

let home: string;
let file: string;
let before: { size: number; mtimeMs: number; text: string };
let stderr: string[];
let stdout: string[];
const fetchSpy = vi.fn(async () => { throw new Error("fetch must not be called in host mode"); });

function mockStdin(input: string): void {
  const stream = Readable.from([Buffer.from(input, "utf-8")]);
  Object.defineProperty(process, "stdin", { configurable: true, get: () => stream });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-host-auth-"));
  mkdirSync(join(home, ".ideaspaces"), { mode: 0o700 });
  file = join(home, ".ideaspaces", "credentials.json");
  writeFileSync(file, JSON.stringify(STORED, null, 2) + "\n", { mode: 0o600 });
  // An old mtime, so any rewrite (even of identical bytes) shows.
  utimesSync(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const stat = statSync(file);
  before = { size: stat.size, mtimeMs: stat.mtimeMs, text: readFileSync(file, "utf8") };
  vi.stubEnv("HOME", home);
  vi.stubEnv("IDEASPACES_AUTH", "host");
  vi.stubEnv("IS_API_KEY", "env-key-must-not-be-used");
  vi.stubEnv("IS_API_URL", "https://api.ideaspaces.test");
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; });
});

afterEach(() => {
  try {
    // The terminal's sign-in file is untouched: same bytes, size and mtime, and nothing new beside it
    // (no lock, no install identity, no temp file).
    const after = statSync(file);
    expect({ size: after.size, mtimeMs: after.mtimeMs, text: readFileSync(file, "utf8") }).toEqual(before);
    expect(readdirSync(join(home, ".ideaspaces"))).toEqual(["credentials.json"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});

const refusal = expect.stringContaining("Remote work is coming through the IdeaSpaces tools; local commands work here.");

describe("IDEASPACES_AUTH=host", () => {
  it("never reads, locks, writes or deletes the sign-in file, and ignores IS_API_KEY", async () => {
    expect(loadStoredCredentials()).toBeNull();
    expect(peekConfig()).toBeNull();
    expect(() => loadConfig()).toThrow(HostAuthRefusal);
    expect(() => loadOptionalAuthConfig()).toThrow(HostAuthRefusal);
    expect(() => saveCredentials({ ...STORED, api_key: "replaced" })).toThrow(HostAuthRefusal);
    expect(() => deleteCredentials()).toThrow(HostAuthRefusal);
    await expect(withCredentialsLock(async () => "ran")).rejects.toThrow(HostAuthRefusal);
    await expect(signOut()).rejects.toThrow(HostAuthRefusal);
    // A config naming the terminal's session still cannot refresh it.
    await expect(resolveSessionConfig({ apiUrl: STORED.api_url, apiKey: STORED.api_key, sessionId: "sess_1" })).rejects.toThrow(HostAuthRefusal);
  });

  it("refuses login and logout with the plain message", async () => {
    expect(await loginCommand.run([], {}, HUMAN)).toBe(1);
    expect(await logoutCommand.run([], {}, JSON_FLAGS)).toBe(1);
    expect(stderr.join("")).toContain("Sign-in isn't available from this `ideaspaces` command");
    expect(stderr.join("")).toContain("Sign-out isn't available from this `ideaspaces` command");
    expect(stderr.join("")).toMatch(/IDEASPACES_AUTH=host/);
    expect(stdout.join("")).toBe("");
  });

  it("stops Git's credential chain for IdeaSpaces hosts, and stays silent for others", async () => {
    mockStdin("protocol=https\nhost=git.ideaspaces.xyz\n\n");
    expect(await credentialCommand.run(["get"], {}, HUMAN)).toBe(1);
    expect(stdout.join("")).toBe("quit=true\n\n");
    expect(stdout.join("")).not.toContain("terminal-access-token");
    expect(stderr.join("")).toEqual(refusal);
    stdout.length = 0;
    mockStdin("protocol=https\nhost=github.com\n\n");
    expect(await credentialCommand.run(["get"], {}, HUMAN)).toBe(0);
    expect(stdout.join("")).toBe("");
  });

  it("refuses remote commands and remote reads, public ones included, before any request", async () => {
    for (const command of [reposCommand, whoamiCommand]) {
      const thrown = await command.run([], {}, HUMAN).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(HostAuthRefusal);
      // What `main` prints for it: the plain message, not "Run: ideaspaces login".
      expect(handleError(thrown, createOutput(HUMAN))).toBe(1);
    }
    expect(stderr.join("")).toEqual(refusal);
    expect(stderr.join("")).not.toContain("ideaspaces login");
    await expect(fetchAuthMe({ apiUrl: STORED.api_url, apiKey: "explicit" })).rejects.toThrow(HostAuthRefusal);
    await expect(optionalAuthRead({ apiUrl: STORED.api_url }, (config) => fetchAuthMe(config as { apiUrl: string; apiKey: string })))
      .rejects.toThrow(HostAuthRefusal);
  });

  it("answers a hosted verb's refusal in the hosted JSON envelope under --json, and only there", () => {
    const refusals = [new HostAuthRefusal("Reading Vaults"), new HostTokenError("--token-fd 7 is not an open descriptor in this process.")];
    for (const error of refusals) {
      for (const command of ["vaults", "threads"]) {
        stdout.length = 0;
        expect(handleError(error, createOutput(JSON_FLAGS), { json: true, command })).toBe(1);
        expect(JSON.parse(stdout.join(""))).toEqual({ schema: "ideaspaces.hosted.error.v1", error: { state: "signed_out", message: error.message } });
      }
      stdout.length = 0;
      // Not a hosted verb, or not --json: nothing on stdout, as before.
      handleError(error, createOutput(JSON_FLAGS), { json: true, command: "repos" });
      handleError(error, createOutput(HUMAN), { json: false, command: "vaults" });
      expect(stdout.join("")).toBe("");
    }
    expect(stdout.join("") + stderr.join("")).not.toContain("terminal-access-token");
  });

  it("keeps local commands working and says where remote work goes", async () => {
    await doctorCommand.run([], {}, JSON_FLAGS);
    const report = JSON.parse(stdout.join(""));
    expect(report.checks.remote_auth).toMatchObject({ state: "not_configured", api_url: null,
      fix: expect.stringContaining("coming through the IdeaSpaces tools") });
    expect(JSON.stringify(report)).not.toContain("terminal-access-token");
  });
});

describe("without the switch", () => {
  it("resolves IS_API_KEY as before", () => {
    vi.stubEnv("IDEASPACES_AUTH", "");
    expect(loadConfig()).toEqual({ apiUrl: "https://api.ideaspaces.test", apiKey: "env-key-must-not-be-used" });
  });
});
