import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const { reqSpy, createClientMock, loadConfigMock, saveCredentialsMock } = vi.hoisted(() => {
  const reqSpy = vi.fn().mockResolvedValue({
    data: {
      repo_id: "repo_connected",
      slug: "ideaspace",
      name: "IdeaSpace",
    },
  });

  const createClientMock = vi.fn(() => ({
    req: reqSpy,
    connectRepo(this: { req: typeof reqSpy }, body: {
      origin_url: string;
      name: string;
      slug?: string;
      hostname?: string | null;
    }) {
      return this.req("POST", "/repos/connect", body);
    },
  }));

  const loadConfigMock = vi.fn(() => ({
    apiKey: "test-key",
    apiUrl: "https://api.ideaspaces.xyz",
    repo: "",
  }));

  const saveCredentialsMock = vi.fn();

  return {
    reqSpy,
    createClientMock,
    loadConfigMock,
    saveCredentialsMock,
  };
});

vi.mock("@ideaspaces/sdk", () => ({
  createClient: createClientMock,
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
  saveCredentials: saveCredentialsMock,
}));

const { connectCommand } = await import("../commands/power/connect.js");

async function runCommand(
  command: { run: (args: string[], flags: Record<string, string | boolean>, global: GlobalFlags) => Promise<number> },
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
    const exitCode = await command.run(args, flags, global);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

describe("connect", () => {
  beforeEach(() => {
    reqSpy.mockClear();
    createClientMock.mockClear();
    loadConfigMock.mockClear();
    loadConfigMock.mockReturnValue({
      apiKey: "test-key",
      apiUrl: "https://api.ideaspaces.xyz",
      repo: "",
    });
    saveCredentialsMock.mockClear();
    delete process.env.IS_API_KEY;
  });

  it("calls connectRepo with bound SDK client method", async () => {
    const { exitCode, stdout } = await runCommand(
      connectCommand,
      ["https://github.com/IdeaSpaces-xyz/ideaspace.git"],
      { name: "IdeaSpace" },
    );

    expect(exitCode).toBe(0);
    expect(createClientMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      apiUrl: "https://api.ideaspaces.xyz",
    });
    expect(reqSpy).toHaveBeenCalledWith("POST", "/repos/connect", {
      origin_url: "https://github.com/IdeaSpaces-xyz/ideaspace.git",
      name: "IdeaSpace",
      slug: undefined,
      hostname: null,
    });
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      api_url: "https://api.ideaspaces.xyz",
      api_key: "test-key",
      repo_id: "repo_connected",
    });
    expect(stdout).toContain("Connected: IdeaSpace (repo_connected)");
  });
});
