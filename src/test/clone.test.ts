import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const GLOBAL: GlobalFlags = {
  json: false,
  quiet: false,
  yes: false,
  help: false,
};

const { listReposMock, createClientMock, loadConfigMock, spawnMock, fetchMock } = vi.hoisted(() => {
  const listReposMock = vi.fn();
  const createClientMock = vi.fn(() => ({ listRepos: listReposMock }));
  const loadConfigMock = vi.fn();
  const spawnMock = vi.fn();
  const fetchMock = vi.fn();
  return { listReposMock, createClientMock, loadConfigMock, spawnMock, fetchMock };
});

vi.mock("@ideaspaces/sdk", () => ({
  createClient: createClientMock,
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { cloneCommand } = await import("../commands/clone.js");

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
  listReposMock.mockReset();
  spawnMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);

  // Default spawn: git exits 0
  spawnMock.mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const proc = {
      on(event: string, cb: (...args: unknown[]) => void) {
        handlers[event] = cb;
        if (event === "exit") setImmediate(() => cb(0));
        return proc;
      },
    };
    return proc as unknown as ReturnType<typeof spawnMock>;
  });
});

afterEach(() => {
  (process.stderr.write as unknown as typeof originalStderr) = originalStderr;
  (process.stdout.write as unknown as typeof originalStdout) = originalStdout;
  vi.unstubAllGlobals();
});

function combinedOutput(): string {
  return stdoutChunks.join("") + stderrChunks.join("");
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("clone — argument handling", () => {
  it("rejects missing target", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    const code = await cloneCommand.run([], {}, GLOBAL);
    expect(code).toBe(2);
    expect(combinedOutput()).toContain("Usage");
  });

  it("rejects missing login", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await cloneCommand.run(["foo/bar"], {}, GLOBAL);
    expect(code).toBe(1);
    expect(combinedOutput()).toContain("Not logged in");
  });

  it("rejects malformed namespace/slug", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    const code = await cloneCommand.run(["foo/bar/baz"], {}, GLOBAL);
    expect(code).toBe(2);
    expect(combinedOutput()).toContain("Invalid target");
  });
});

describe("clone — explicit <namespace>/<slug>", () => {
  it("spawns git clone with the built URL", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_1",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });
    const code = await cloneCommand.run(["stripe.com/architecture"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/stripe.com/architecture.git"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("appends directory argument when given", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    await cloneCommand.run(["stripe.com/notes", "./work/notes"], {}, GLOBAL);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "https://git.ideaspaces.xyz/stripe.com/notes.git",
        "./work/notes",
      ],
      expect.anything(),
    );
  });

  it("uses IS_GIT_URL override if set", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    const prev = process.env.IS_GIT_URL;
    process.env.IS_GIT_URL = "http://git.localhost:8000";
    try {
      await cloneCommand.run(["alice/notes"], {}, GLOBAL);
      expect(spawnMock).toHaveBeenCalledWith(
        "git",
        ["clone", "http://git.localhost:8000/alice/notes.git"],
        expect.anything(),
      );
    } finally {
      if (prev === undefined) delete process.env.IS_GIT_URL;
      else process.env.IS_GIT_URL = prev;
    }
  });
});

describe("clone — bare slug resolution", () => {
  it("picks personal repo when user has one matching", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "sk_sw_1",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });
    listReposMock.mockResolvedValue({
      data: {
        repos: [
          { repo_id: "repo_1", slug: "notes", hostname: null, role: "OWNER" },
          { repo_id: "repo_2", slug: "other", hostname: null, role: "OWNER" },
        ],
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ username: "alice" }),
    });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/alice/notes.git"],
      expect.anything(),
    );
  });

  it("errors when no repo matches bare slug", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({
      data: {
        repos: [{ repo_id: "repo_1", slug: "other", hostname: null, role: "OWNER" }],
      },
    });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(4);
    expect(combinedOutput()).toContain('No space found with slug "notes"');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("hints when hostname variant also exists alongside personal", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({
      data: {
        repos: [
          { repo_id: "repo_1", slug: "notes", hostname: null, role: "OWNER" },
          { repo_id: "repo_2", slug: "notes", hostname: "stripe.com", role: "MEMBER" },
        ],
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ username: "alice" }),
    });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(combinedOutput()).toContain("stripe.com/notes");
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/alice/notes.git"],
      expect.anything(),
    );
  });

  it("picks hostname repo when that's the only match", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({
      data: {
        repos: [
          { repo_id: "repo_1", slug: "notes", hostname: "stripe.com", role: "MEMBER" },
        ],
      },
    });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://git.ideaspaces.xyz/stripe.com/notes.git"],
      expect.anything(),
    );
  });

  it("errors when multiple hostname variants match and no personal", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({
      data: {
        repos: [
          { repo_id: "repo_1", slug: "notes", hostname: "stripe.com", role: "MEMBER" },
          { repo_id: "repo_2", slug: "notes", hostname: "acme.com", role: "MEMBER" },
        ],
      },
    });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(4);
    const out = combinedOutput();
    expect(out).toContain("Multiple spaces");
    expect(out).toContain("stripe.com/notes");
    expect(out).toContain("acme.com/notes");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("errors if username fetch fails for personal match", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({
      data: {
        repos: [{ repo_id: "repo_1", slug: "notes", hostname: null, role: "OWNER" }],
      },
    });
    fetchMock.mockResolvedValue({ ok: false });

    const code = await cloneCommand.run(["notes"], {}, GLOBAL);
    expect(code).toBe(4);
    expect(combinedOutput()).toContain("username");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
