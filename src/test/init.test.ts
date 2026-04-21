import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const GLOBAL: GlobalFlags = {
  json: false,
  quiet: false,
  yes: false,
  help: false,
};

const {
  createRepoMock,
  createClientMock,
  loadConfigMock,
  saveCredentialsMock,
  spawnMock,
  execFileSyncMock,
  fetchMock,
} = vi.hoisted(() => {
  const createRepoMock = vi.fn();
  const createClientMock = vi.fn(() => ({ createRepo: createRepoMock }));
  const loadConfigMock = vi.fn();
  const saveCredentialsMock = vi.fn();
  const spawnMock = vi.fn();
  const execFileSyncMock = vi.fn();
  const fetchMock = vi.fn();
  return {
    createRepoMock,
    createClientMock,
    loadConfigMock,
    saveCredentialsMock,
    spawnMock,
    execFileSyncMock,
    fetchMock,
  };
});

vi.mock("@ideaspaces/sdk", () => ({ createClient: createClientMock }));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
  saveCredentials: saveCredentialsMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

const { initCommand } = await import("../commands/init.js");

// ─── Harness ──────────────────────────────────────────────────────────

let stderrChunks: string[];
let stdoutChunks: string[];
let originalStderr: typeof process.stderr.write;
let originalStdout: typeof process.stdout.write;

beforeEach(() => {
  stderrChunks = [];
  stdoutChunks = [];
  originalStderr = process.stderr.write.bind(process.stderr);
  originalStdout = process.stdout.write.bind(process.stdout);
  (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  loadConfigMock.mockReset();
  createRepoMock.mockReset();
  saveCredentialsMock.mockReset();
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);

  // Default: /auth/me returns a fully-onboarded user.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      user_id: 42,
      username: "alice",
      email: "alice@ideaspaces.xyz",
      name: "Alice",
    }),
  });

  // Default spawn: git clone exits 0.
  spawnMock.mockImplementation(() => {
    const proc = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "exit") setImmediate(() => cb(0));
        return proc;
      },
    };
    return proc as unknown as ReturnType<typeof spawnMock>;
  });

  // execFileSync (git config) succeeds silently.
  execFileSyncMock.mockReturnValue("");
});

afterEach(() => {
  (process.stderr.write as unknown as typeof originalStderr) = originalStderr;
  (process.stdout.write as unknown as typeof originalStdout) = originalStdout;
  vi.unstubAllGlobals();
});

function combinedOutput(): string {
  return stdoutChunks.join("") + stderrChunks.join("");
}

// ─── Argument handling ──────────────────────────────────────────────

describe("init — argument handling", () => {
  it("rejects missing login", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await initCommand.run(["My Space"], {}, GLOBAL);
    expect(code).toBe(2);
    expect(combinedOutput()).toContain("Not logged in");
  });

  it("rejects missing name", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    const code = await initCommand.run([], {}, GLOBAL);
    expect(code).toBe(1);
    expect(combinedOutput()).toContain("Name required");
  });

  it("rejects when /auth/me fails", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const code = await initCommand.run(["Test"], {}, GLOBAL);
    expect(code).toBe(1);
    expect(combinedOutput()).toContain("/auth/me returned 401");
    // Must bail before hitting createRepo — no half-created state on the server.
    expect(createRepoMock).not.toHaveBeenCalled();
  });

  it("rejects when account has no email", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        user_id: 1,
        username: "alice",
        email: null,
        name: "Alice",
      }),
    });
    const code = await initCommand.run(["Test"], {}, GLOBAL);
    expect(code).toBe(1);
    expect(combinedOutput()).toContain("no email recorded");
    expect(createRepoMock).not.toHaveBeenCalled();
  });
});

// ─── Happy path ─────────────────────────────────────────────────────

describe("init — personal space (no --hostname)", () => {
  it("creates space, clones, sets local git identity", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_1",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });
    createRepoMock.mockResolvedValue({
      data: { repo_id: "repo_abc", slug: "my-notes", name: "My Notes" },
    });

    const code = await initCommand.run(["My Notes"], {}, GLOBAL);
    expect(code).toBe(0);

    // Space created with the name the user supplied.
    expect(createRepoMock).toHaveBeenCalledWith({
      name: "My Notes",
      slug: undefined,
      purpose: undefined,
    });

    // Namespace is the OAuth username — no --hostname flag.
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/alice/my-notes.git", "my-notes"],
      expect.any(Object),
    );

    // Local git identity wired to the OAuth account — closes the
    // "agent:cli attribution" loop from the dogfood walk.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "user.email", "alice@ideaspaces.xyz"],
      expect.objectContaining({ cwd: "my-notes" }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "user.name", "Alice"],
      expect.objectContaining({ cwd: "my-notes" }),
    );

    // Credentials updated so subsequent CLI commands target this repo.
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      api_url: "https://api.ideaspaces.xyz",
      api_key: "sk_sw_1",
      repo_id: "repo_abc",
    });
  });

  it("uses --dir override for the clone target", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    createRepoMock.mockResolvedValue({
      data: { repo_id: "r", slug: "notes", name: "N" },
    });

    await initCommand.run(["N"], { dir: "./custom-dir" }, GLOBAL);

    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", expect.stringContaining("/alice/notes.git"), "./custom-dir"],
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["config", "--local", "user.email"]),
      expect.objectContaining({ cwd: "./custom-dir" }),
    );
  });
});

describe("init — hostname-scoped space", () => {
  it("uses hostname as the namespace when --hostname is set", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    createRepoMock.mockResolvedValue({
      data: { repo_id: "r", slug: "arch", name: "Arch" },
    });

    await initCommand.run(["Arch"], { hostname: "acme.com" }, GLOBAL);

    // Namespace in the clone URL is the hostname, not the personal handle.
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/acme.com/arch.git", "arch"],
      expect.any(Object),
    );
  });
});

// ─── Failure paths ──────────────────────────────────────────────────

describe("init — git clone failure", () => {
  it("returns git's exit code when clone fails", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    createRepoMock.mockResolvedValue({
      data: { repo_id: "r", slug: "notes", name: "N" },
    });

    // Simulate git clone returning non-zero.
    spawnMock.mockImplementationOnce(() => {
      const proc = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "exit") setImmediate(() => cb(128));
          return proc;
        },
      };
      return proc as unknown as ReturnType<typeof spawnMock>;
    });

    const code = await initCommand.run(["N"], {}, GLOBAL);
    expect(code).toBe(128);
    // Important: we flag that the server DID create the space, so the user
    // can recover without re-calling createRepo.
    expect(combinedOutput()).toContain("space was created on the server");
    // Identity config shouldn't run since clone never produced a dir.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("warns but returns 0 when git config fails after a successful clone", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    createRepoMock.mockResolvedValue({
      data: { repo_id: "r", slug: "notes", name: "N" },
    });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git config: permission denied");
    });

    const code = await initCommand.run(["N"], {}, GLOBAL);
    // Clone succeeded, identity config is recoverable — degrade gracefully.
    expect(code).toBe(0);
    expect(combinedOutput()).toContain("failed to set local git identity");
  });
});
