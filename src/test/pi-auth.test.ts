import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAuth,
  removeProvider,
  resolvePiAgentDir,
  resolvePiAuthPath,
  upsertApiKey,
  readAuthFile,
  writeAuthFile,
} from "../pi/pi-auth.js";
import type { PiAuth } from "../pi/pi-auth.js";

describe("resolvePiAgentDir / resolvePiAuthPath", () => {
  it("defaults to ~/.pi/agent when the override is unset", () => {
    const dir = resolvePiAgentDir({});
    expect(dir.endsWith(join(".pi", "agent"))).toBe(true);
    expect(resolvePiAuthPath({}).endsWith(join(".pi", "agent", "auth.json"))).toBe(true);
  });

  it("honors PI_CODING_AGENT_DIR so we write where pi reads", () => {
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe("/custom/agent");
    expect(resolvePiAuthPath({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe(
      "/custom/agent/auth.json",
    );
  });
});

describe("parseAuth", () => {
  it("returns {} for empty, whitespace, malformed, or non-object bodies", () => {
    expect(parseAuth(undefined)).toEqual({});
    expect(parseAuth("")).toEqual({});
    expect(parseAuth("   ")).toEqual({});
    expect(parseAuth("not json")).toEqual({});
    expect(parseAuth("[1,2]")).toEqual({}); // array is not a provider map
  });

  it("parses a real provider map", () => {
    expect(parseAuth('{"anthropic":{"type":"api_key","key":"k"}}')).toEqual({
      anthropic: { type: "api_key", key: "k" },
    });
  });
});

describe("upsertApiKey", () => {
  it("writes the api_key tagged-union shape pi reads", () => {
    expect(upsertApiKey({}, "anthropic", "sk-ant")).toEqual({
      anthropic: { type: "api_key", key: "sk-ant" },
    });
  });

  it("preserves other providers and overwrites the same one", () => {
    const current: PiAuth = {
      openai: { type: "api_key", key: "old" },
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    };
    const next = upsertApiKey(current, "openai", "new");
    expect(next.openai).toEqual({ type: "api_key", key: "new" });
    expect(next.anthropic).toEqual(current.anthropic); // untouched
    expect(current.openai).toEqual({ type: "api_key", key: "old" }); // input not mutated
  });
});

describe("removeProvider", () => {
  it("removes an existing provider, leaving others", () => {
    const current: PiAuth = {
      openai: { type: "api_key", key: "k" },
      anthropic: { type: "api_key", key: "k2" },
    };
    const { next, removed } = removeProvider(current, "openai");
    expect(removed).toBe(true);
    expect(next).toEqual({ anthropic: { type: "api_key", key: "k2" } });
    expect(current.openai).toBeDefined(); // input not mutated
  });

  it("reports removed:false when the provider is absent", () => {
    const { next, removed } = removeProvider({ a: { type: "api_key", key: "k" } }, "ghost");
    expect(removed).toBe(false);
    expect(next).toEqual({ a: { type: "api_key", key: "k" } });
  });
});

describe("readAuthFile / writeAuthFile round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("absent file reads as {}", () => {
    expect(readAuthFile(join(dir, "nope", "auth.json"))).toEqual({});
  });

  it("writes 0600, creates the parent dir, and reads back the same map", async () => {
    const path = join(dir, "agent", "auth.json"); // parent doesn't exist yet
    const auth = upsertApiKey({}, "anthropic", "sk-ant");
    writeAuthFile(path, auth);

    expect(readAuthFile(path)).toEqual(auth);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-chmods a pre-existing looser file to 0600", async () => {
    const path = join(dir, "auth.json");
    await writeFile(path, "{}", { mode: 0o644 });
    writeAuthFile(path, upsertApiKey({}, "openai", "k"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing provider when logging in another (real login flow)", async () => {
    const path = join(dir, "auth.json");
    writeAuthFile(path, upsertApiKey({}, "anthropic", "a-key"));
    // second login for a different provider must not drop the first
    writeAuthFile(path, upsertApiKey(readAuthFile(path), "openai", "o-key"));
    expect(readAuthFile(path)).toEqual({
      anthropic: { type: "api_key", key: "a-key" },
      openai: { type: "api_key", key: "o-key" },
    });
  });
});
