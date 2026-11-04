import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAuthMe, RetiredEndpointError, type ApiConfig } from "../auth/api.js";
import type { Install } from "../install-kind.js";
import {
  afterCommand,
  fetchLatestVersion,
  isBehind,
  isVersion,
  knownLatestForCompare,
  mayCheckForUpdates,
  noticeAllowed,
  noticeLine,
  outOfDateMessage,
  readUpdateState,
  type NoticeContext,
} from "../update-check.js";
import { CLI_VERSION } from "../version.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const NPM: Install = { kind: "npm", path: "/usr/local/lib/node_modules/@ideaspaces/cli/bundle/ideaspaces.js", owner: "/usr/local/lib" };

describe("versions", () => {
  it("compares numerically, not as text", () => {
    expect(isBehind("0.9.0", "0.10.0")).toBe(true);
    expect(isBehind("0.10.0", "0.9.0")).toBe(false);
    expect(isBehind("1.2.3", "1.2.3")).toBe(false);
    expect(isBehind("0.7.1", "0.6.0")).toBe(false);
  });

  it("a prerelease sorts before its release", () => {
    expect(isBehind("1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(isBehind("1.0.0", "1.0.0-beta.1")).toBe(false);
  });

  it("refuses anything that is not a plain version", () => {
    expect(isVersion("0.7.1")).toBe(true);
    expect(isVersion("1.0.0-rc.1")).toBe(true);
    expect(isVersion("latest")).toBe(false);
    expect(isVersion("1.0.0\u001b[31m")).toBe(false);
    expect(isVersion("1.0.0 && rm -rf /")).toBe(false);
    expect(isVersion(7)).toBe(false);
    expect(isBehind("0.7.1", "not-a-version")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads npm's latest, refusing redirects", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ version: "0.8.0" })));
    vi.stubGlobal("fetch", fetched);

    await expect(fetchLatestVersion({ timeoutMs: 100, env: {} })).resolves.toBe("0.8.0");

    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/@ideaspaces/cli/latest");
    expect(init.redirect).toBe("error");
  });

  it("uses a configured registry", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ version: "0.8.0" })));
    vi.stubGlobal("fetch", fetched);

    await fetchLatestVersion({ timeoutMs: 100, env: { npm_config_registry: "https://mirror.example/npm/" } });

    expect((fetched.mock.calls[0] as unknown as [string])[0]).toBe("https://mirror.example/npm/@ideaspaces/cli/latest");
  });

  it("throws on a refusal or an unusable version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(fetchLatestVersion({ timeoutMs: 100, env: {} })).rejects.toThrow("503");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "\u001b[2Jhi" }))));
    await expect(fetchLatestVersion({ timeoutMs: 100, env: {} })).rejects.toThrow("no usable version");
  });
});

describe("noticeAllowed", () => {
  const speaking: NoticeContext = { command: "status", json: false, quiet: false, stdoutTTY: true, stderrTTY: true, env: {}, install: NPM };

  it("speaks to a person at a terminal", () => {
    expect(noticeAllowed(speaking)).toBe(true);
  });

  it.each<[string, Partial<NoticeContext>]>([
    ["--json", { json: true }],
    ["--quiet", { quiet: true }],
    ["piped stdout", { stdoutTTY: false }],
    ["piped stderr", { stderrTTY: false }],
    ["CI", { env: { CI: "true" } }],
    ["CI=1", { env: { CI: "1" } }],
    ["the opt-out", { env: { IDEASPACES_NO_UPDATE_CHECK: "1" } }],
    ["the common opt-out", { env: { NO_UPDATE_NOTIFIER: "1" } }],
    ["host mode", { env: { IDEASPACES_AUTH: "host" } }],
    ["an agent's terminal", { env: { AI_AGENT: "claude-code" } }],
    ["Claude Code", { env: { CLAUDECODE: "1" } }],
    ["Git's credential helper", { command: "credential" }],
    ["upgrade itself", { command: "upgrade" }],
    ["the check itself", { command: "__update-check" }],
    ["a plugin copy", { install: { kind: "plugin", path: "/p" } }],
    ["a Pi copy", { install: { kind: "pi", path: "/p" } }],
    ["the app's copy", { install: { kind: "app", path: "/p" } }],
    ["a project's copy", { install: { kind: "dependency", path: "/p" } }],
    ["an unknown copy", { install: { kind: "unknown", path: "/p" } }],
  ])("is silent for %s", (_name, change) => {
    expect(noticeAllowed({ ...speaking, ...change })).toBe(false);
  });

  it("treats CI=false as not CI", () => {
    expect(mayCheckForUpdates({ CI: "false" })).toBe(true);
    expect(mayCheckForUpdates({ IDEASPACES_NO_UPDATE_CHECK: "0" })).toBe(true);
  });
});

describe("afterCommand", () => {
  let home: string;
  let previousHome: string | undefined;

  function stateFile(): string {
    return join(home, ".ideaspaces", "update-check.json");
  }
  function seed(state: unknown): void {
    mkdirSync(join(home, ".ideaspaces"), { recursive: true });
    writeFileSync(stateFile(), typeof state === "string" ? state : JSON.stringify(state));
  }
  function run(overrides: { now?: number; env?: Record<string, string>; json?: boolean; stdoutTTY?: boolean } = {}) {
    const lines: string[] = [];
    const refresh = vi.fn();
    afterCommand(
      { command: "status", json: overrides.json ?? false, quiet: false },
      {
        now: overrides.now ?? NOW,
        env: overrides.env ?? {},
        stdoutTTY: overrides.stdoutTTY ?? true,
        stderrTTY: true,
        install: NPM,
        current: "0.7.1",
        refresh,
        write: (line) => lines.push(line),
      },
    );
    return { lines, refresh };
  }

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "is-update-check-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("on the first run, starts the check and says nothing", () => {
    const { lines, refresh } = run();
    expect(refresh).toHaveBeenCalledOnce();
    expect(lines).toEqual([]);
    expect(readUpdateState().checked_at).toBe(NOW);
  });

  it("checks at most once a day, even when a check fails", () => {
    run();
    expect(run({ now: NOW + DAY - 1 }).refresh).not.toHaveBeenCalled();
    expect(run({ now: NOW + DAY }).refresh).toHaveBeenCalledOnce();
  });

  it("prints one line when behind, then not again that day", () => {
    seed({ checked_at: NOW, latest: "0.8.0" });
    expect(run().lines).toEqual(["ideaspaces 0.8.0 is available (you have 0.7.1). Run: ideaspaces upgrade"]);
    expect(run({ now: NOW + DAY - 1 }).lines).toEqual([]);
    expect(run({ now: NOW + DAY }).lines).toHaveLength(1);
  });

  it("says nothing when current or ahead", () => {
    seed({ checked_at: NOW, latest: "0.7.1" });
    expect(run().lines).toEqual([]);
    seed({ checked_at: NOW, latest: "0.6.0" });
    expect(run().lines).toEqual([]);
  });

  it("touches nothing when silent", () => {
    expect(run({ json: true })).toMatchObject({ lines: [] });
    expect(run({ env: { CI: "1" } }).refresh).not.toHaveBeenCalled();
    expect(run({ stdoutTTY: false }).refresh).not.toHaveBeenCalled();
    expect(() => readFileSync(stateFile())).toThrow();
  });

  it("survives a torn file, a clock jump and a hostile version", () => {
    seed("{not json");
    expect(run().refresh).toHaveBeenCalledOnce();
    seed({ checked_at: NOW + 10 * DAY });
    expect(run().refresh).toHaveBeenCalledOnce();
    seed({ checked_at: NOW, latest: "9.9.9\u001b]0;owned\u0007" });
    expect(run().lines).toEqual([]);
  });

  it("never throws when the state cannot be written", () => {
    writeFileSync(join(home, ".ideaspaces"), "a file where the folder goes");
    expect(() => run()).not.toThrow();
  });
});

describe("outOfDateMessage", () => {
  it("says what you have, what is needed and what to run", () => {
    expect(outOfDateMessage("0.8.0", NPM, "0.6.0")).toBe(
      "This CLI is out of date: you have 0.6.0, and the latest is 0.8.0.\nRun: ideaspaces upgrade",
    );
  });

  it("still says what you have and what to run when the latest is unknown", () => {
    expect(outOfDateMessage(null, { kind: "plugin", path: "/p" }, "0.6.0")).toBe(
      "This CLI is out of date: you have 0.6.0, and this service needs a newer one.\n" +
        "This copy comes with the IdeaSpaces plugin. Update the plugin, in Claude Code: claude plugin update ideaspaces@ideaspaces-xyz, then restart.",
    );
  });

  it("an old check never claims nothing newer is out", () => {
    expect(outOfDateMessage("0.6.0", NPM, "0.7.1")).toBe(
      "This CLI is out of date: you have 0.7.1, and this service needs a newer one.\nRun: ideaspaces upgrade",
    );
  });
});

describe("the 410 path", () => {
  const config: ApiConfig = { apiUrl: "https://api.test", apiKey: "is_x" };
  afterEach(() => vi.unstubAllGlobals());

  it("names the version in the error a retired route raises", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "This endpoint was retired." }), { status: 410 })));

    const err = await fetchAuthMe(config, { retry: false }).catch((e: unknown) => e) as RetiredEndpointError;

    expect(err).toBeInstanceOf(RetiredEndpointError);
    expect(err.message).toContain("GET /auth/me → 410: This endpoint was retired.");
    expect(err.message).toContain(`you have ${CLI_VERSION}`);
    expect(err.message).toContain("this service needs a newer one");

  });

  it("names what the last check found and makes no call of its own to the registry", async () => {
    const home = mkdtempSync(join(tmpdir(), "is-410-"));
    mkdirSync(join(home, ".ideaspaces"));
    writeFileSync(join(home, ".ideaspaces", "update-check.json"), JSON.stringify({ latest: "99.0.0" }));
    vi.stubEnv("HOME", home);
    const fetched = vi.fn(async () => new Response(JSON.stringify({ detail: "gone" }), { status: 410 }));
    vi.stubGlobal("fetch", fetched);
    try {
      const err = await fetchAuthMe(config, { retry: false }).catch((e: unknown) => e) as RetiredEndpointError;
      expect(err.message).toContain(`you have ${CLI_VERSION}, and the latest is 99.0.0.`);
      expect(fetched).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("knownLatestForCompare", () => {
  let home: string;
  const write = (state: unknown) => writeFileSync(join(home, ".ideaspaces", "update-check.json"), JSON.stringify(state));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "is-compare-"));
    mkdirSync(join(home, ".ideaspaces"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("IDEASPACES_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("IDEASPACES_AUTH", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("has nothing to say with no check", () => {
    expect(knownLatestForCompare("0.8.0", NOW)).toBeNull();
  });

  it("trusts a recent check either way", () => {
    write({ latest: "0.8.0", checked_at: NOW - DAY });
    expect(knownLatestForCompare("0.8.0", NOW)).toBe("0.8.0");
    expect(knownLatestForCompare("0.7.1", NOW)).toBe("0.8.0");
  });

  it("an old check can still say behind, but not current", () => {
    write({ latest: "0.8.0", checked_at: NOW - 30 * DAY });
    expect(knownLatestForCompare("0.7.1", NOW)).toBe("0.8.0");
    expect(knownLatestForCompare("0.8.0", NOW)).toBeNull();
  });

  it("says nothing with the check turned off", () => {
    write({ latest: "0.8.0", checked_at: NOW });
    vi.stubEnv("IDEASPACES_NO_UPDATE_CHECK", "1");
    expect(knownLatestForCompare("0.7.1", NOW)).toBeNull();
  });
});

describe("noticeLine", () => {
  it("is one line", () => {
    expect(noticeLine("0.8.0", NPM, "0.7.1")).not.toContain("\n");
  });
});
