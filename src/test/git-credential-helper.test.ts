import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});

// Mock the callback-form execFile that promisify() wraps. The trailing arg is
// the callback; the leading two are (file, args).
vi.mock("node:child_process", () => ({
  execFile: (...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    const file = allArgs[0] as string;
    const args = allArgs[1] as string[];
    try {
      const result = execFileMock(file, args);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<{ stdout?: string; stderr?: string }>).then(
          (r) => cb(null, { stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" }),
          (err: Error) => cb(err, { stdout: "", stderr: "" }),
        );
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    } catch (err) {
      cb(err as Error, { stdout: "", stderr: "" });
    }
  },
}));

const { registerGitCredentialHelper } = await import("../auth/git-credential-helper.js");

const HOSTS = ["https://git.ideaspaces.xyz", "https://git.ideaspaces.localhost"];

// Calls whose args target a given host's helper key, in invocation order.
function callsForHost(host: string): string[][] {
  const key = `credential.${host}.helper`;
  return execFileMock.mock.calls
    .map((c) => c[1] as string[])
    .filter((args) => args.includes(key));
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("registerGitCredentialHelper", () => {
  it("resets the chain then registers an absolute-path helper, per host", async () => {
    execFileMock.mockReturnValue(undefined);

    await registerGitCredentialHelper();

    for (const host of HOSTS) {
      const calls = callsForHost(host);
      // Exactly three calls per host, in order:
      //   1. unset-all          (clears any prior value)
      //   2. --add '' (empty)   (resets the chain for this URL)
      //   3. --add '!<abs> …'   (our helper, as the only entry)
      expect(calls, `calls for ${host}`).toHaveLength(3);
      expect(calls[0]).toContain("--unset-all");
      expect(calls[1]).toContain("--add");
      expect(calls[1].at(-1)).toBe(""); // reset sentinel
      const helper = calls[2].at(-1)!;
      // Helper is `!<shell-quoted absolute exe path> [script] credential` — it
      // must NOT be the bare `!ideaspaces …` that breaks off-PATH (the bug).
      expect(helper.startsWith("!")).toBe(true);
      expect(helper.endsWith(" credential")).toBe(true);
      expect(helper).toContain(process.execPath);
      expect(helper).not.toMatch(/^!ideaspaces /);
    }
  });

  it("swallows errors silently (best-effort)", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("git: command not found");
    });

    // Must not throw — user can still type API key manually at prompt.
    await expect(registerGitCredentialHelper()).resolves.toBeUndefined();
  });

  it("tolerates --unset-all returning non-zero when the key is missing", async () => {
    // --unset-all exits 5 when no matching section/key exists. Our code catches
    // that specifically so the rest of the sequence runs.
    execFileMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--unset-all")) return Promise.reject(new Error("exit code 5"));
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await expect(registerGitCredentialHelper()).resolves.toBeUndefined();

    const addCalls = execFileMock.mock.calls.filter((c) => (c[1] as string[]).includes("--add"));
    expect(addCalls.length).toBeGreaterThanOrEqual(4); // 2 hosts × 2 --add calls
  });
});
