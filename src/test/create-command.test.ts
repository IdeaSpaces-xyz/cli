import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkError } from "@ideaspaces/sdk";
import { handleError } from "../errors.js";
import { createOutput } from "../output.js";
import type { GlobalFlags } from "../types.js";

const { createRepoSpy, createClientMock, loadConfigMock, saveCredentialsMock } = vi.hoisted(() => {
  const createRepoSpy = vi.fn().mockResolvedValue({
    data: {
      repo_id: "repo_new",
      slug: "team-notes",
      name: "Team Notes",
    },
  });

  const createClientMock = vi.fn(() => ({
    createRepo: createRepoSpy,
  }));

  const loadConfigMock = vi.fn(() => ({
    apiKey: "test-key",
    apiUrl: "https://api.ideaspaces.xyz",
    repo: "",
  }));

  const saveCredentialsMock = vi.fn();

  return {
    createRepoSpy,
    createClientMock,
    loadConfigMock,
    saveCredentialsMock,
  };
});

vi.mock("@ideaspaces/sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@ideaspaces/sdk")>();
  return {
    ...orig,
    createClient: createClientMock,
  };
});

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
  saveCredentials: saveCredentialsMock,
}));

const { createCommand } = await import("../commands/power/create.js");

async function runCommand(
  args: string[] = [],
  flags: Record<string, string | boolean> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const global: GlobalFlags = {
    json: false,
    quiet: false,
    yes: false,
    help: false,
  };

  let stdout = "";
  let stderr = "";

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    let exitCode: number;
    try {
      exitCode = await createCommand.run(args, flags, global);
    } catch (err) {
      exitCode = handleError(err, createOutput(global));
    }
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

describe("power create", () => {
  beforeEach(() => {
    createRepoSpy.mockReset();
    createRepoSpy.mockResolvedValue({
      data: {
        repo_id: "repo_new",
        slug: "team-notes",
        name: "Team Notes",
      },
    });

    createClientMock.mockClear();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({
      apiKey: "test-key",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });

    saveCredentialsMock.mockClear();
    delete process.env.IS_API_KEY;
  });

  it("creates a repo and auto-connects credentials", async () => {
    const { exitCode, stdout } = await runCommand(["Team Notes"], {
      slug: "team-notes",
      purpose: "Track team architecture decisions",
    });

    expect(exitCode).toBe(0);
    expect(createClientMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      apiUrl: "https://api.ideaspaces.xyz",
    });
    expect(createRepoSpy).toHaveBeenCalledWith({
      name: "Team Notes",
      slug: "team-notes",
      purpose: "Track team architecture decisions",
    });
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      api_url: "https://api.ideaspaces.xyz",
      api_key: "test-key",
      repo_id: "repo_new",
    });
    expect(stdout).toContain("Created and connected: Team Notes (team-notes)");
  });

  it("returns auth guidance when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    const { exitCode, stderr } = await runCommand(["Team Notes"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Not logged in. Run: ideaspaces login");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("errors when name is missing", async () => {
    const { exitCode, stderr } = await runCommand([]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Name required");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("surfaces API client errors", async () => {
    createRepoSpy.mockRejectedValue(
      new SdkError({
        message: "POST /repos: 409 — slug already exists",
        category: "client_error",
        status: 409,
        retryable: false,
      }),
    );

    const { exitCode, stderr } = await runCommand(["Team Notes"], { slug: "team-notes" });

    expect(exitCode).toBe(5);
    expect(stderr).toContain("slug already exists");
  });
});
