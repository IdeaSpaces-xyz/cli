import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type StoredCredentials } from "../auth/credentials.js";
import { reposCommand } from "../commands/repos.js";
import { whoamiCommand } from "../commands/whoami.js";
import type { GlobalFlags } from "../types.js";
import { captureStdout } from "./helpers.js";

const SERVICE = "https://api.ideaspaces.test";
const ELSEWHERE = "http://127.0.0.1:4010";
const GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

const KEY: StoredCredentials = { api_url: SERVICE, api_key: "stored-key" };
const SESSION: StoredCredentials = {
  api_url: SERVICE,
  api_key: "stored-access",
  session: { id: "session-one", install_id: "install-one", refresh_token: "stored-refresh", expires_at: Date.now() + 3_600_000, refresh_expires_at: Date.now() + 86_400_000 },
};

describe("a stored credential belongs to its service", () => {
  let home: string;
  let fetched: ReturnType<typeof vi.fn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  function store(credentials: Partial<StoredCredentials>): void {
    mkdirSync(join(home, ".ideaspaces"), { recursive: true });
    writeFileSync(join(home, ".ideaspaces", "credentials.json"), JSON.stringify(credentials));
  }
  const authorizations = () => fetched.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>).map((h) => h.Authorization);
  const urls = () => fetched.mock.calls.map(([url]) => String(url));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "is-stored-destination-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("IS_API_KEY", "");
    vi.stubEnv("IS_API_URL", "");
    fetched = vi.fn(async () => Response.json({ repos: [], username: "one" }));
    vi.stubGlobal("fetch", fetched);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([["key", KEY], ["session", SESSION]])("a stored %s with a different IS_API_URL is refused, and no request is made", async (_name, credentials) => {
    store(credentials);
    vi.stubEnv("IS_API_URL", ELSEWHERE);

    expect(loadConfig()).toBeNull();
    await captureStdout(() => reposCommand.run([], {}, GLOBAL));
    await captureStdout(() => whoamiCommand.run([], {}, GLOBAL));

    expect(fetched).not.toHaveBeenCalled();
  });

  it("a stored key with no api_url belongs to the default service", () => {
    store({ api_key: "stored-key" });
    vi.stubEnv("IS_API_URL", ELSEWHERE);

    expect(loadConfig()).toBeNull();
  });

  it("a matching IS_API_URL still works, trailing slash or not", async () => {
    store(KEY);
    vi.stubEnv("IS_API_URL", `${SERVICE}/`);

    expect(loadConfig()).toMatchObject({ apiUrl: SERVICE, apiKey: "stored-key" });
    await captureStdout(() => reposCommand.run([], {}, GLOBAL));

    expect(urls()[0]).toMatch(new RegExp(`^${SERVICE}/`));
    expect(authorizations()[0]).toBe("Bearer stored-key");
  });

  it("with IS_API_URL unset, the stored credential goes to its own service", () => {
    store(KEY);

    expect(loadConfig()).toMatchObject({ apiUrl: SERVICE, apiKey: "stored-key" });
  });

  it("IS_API_KEY stays the way to pair a key with another server, and the stored key stays home", async () => {
    store(KEY);
    vi.stubEnv("IS_API_URL", ELSEWHERE);
    vi.stubEnv("IS_API_KEY", "caller-key");

    expect(loadConfig()).toEqual({ apiUrl: ELSEWHERE, apiKey: "caller-key" });
    await captureStdout(() => reposCommand.run([], {}, GLOBAL));

    expect(urls()[0]).toMatch(new RegExp(`^${ELSEWHERE}/`));
    expect(authorizations()).not.toContain("Bearer stored-key");
  });

  it("says why, once, naming both ways forward and no secret", async () => {
    vi.resetModules();
    const { loadConfig: fresh } = await import("../auth/credentials.js");
    store(KEY);
    vi.stubEnv("IS_API_URL", `${ELSEWHERE}\u001b[2J`);

    fresh();
    fresh();

    const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stderr).toHaveBeenCalledOnce();
    expect(text).toContain(`belongs to ${SERVICE}`);
    expect(text).toContain("unset IS_API_URL");
    expect(text).toContain("set IS_API_KEY");
    expect(text).not.toContain("stored-key");
    expect(text).not.toContain("\u001b");
  });
});
