import { beforeEach, describe, expect, it, vi } from "vitest";

const { execMock } = vi.hoisted(() => {
  const execMock = vi.fn();
  return { execMock };
});

vi.mock("node:child_process", () => ({
  exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    try {
      const result = execMock(cmd);
      // Allow tests to throw from the mock to simulate non-zero exits.
      if (result && typeof result.then === "function") {
        result.then(
          (r: { stdout?: string; stderr?: string }) =>
            cb(null, { stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" }),
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

beforeEach(() => {
  execMock.mockReset();
});

describe("registerGitCredentialHelper", () => {
  it("resets the helper chain before adding !ideaspaces for each host", async () => {
    execMock.mockReturnValue(undefined);

    await registerGitCredentialHelper();

    const commands = execMock.mock.calls.map((c) => c[0] as string);
    const hosts = ["https://git.ideaspaces.xyz", "https://git.ideaspaces.localhost"];

    for (const host of hosts) {
      const key = `'credential.${host}.helper'`;
      const hostCmds = commands.filter((c) => c.includes(key));
      // Exactly three calls per host, in order:
      //   1. unset-all            (clears any prior value)
      //   2. --add '' (empty)     (resets the chain for this URL)
      //   3. --add '!ideaspaces…' (our helper, as the only entry)
      expect(hostCmds, `commands for ${host}`).toHaveLength(3);
      expect(hostCmds[0]).toMatch(/--unset-all/);
      // Reset sentinel: empty string, either '' or "" — both equivalent in shell.
      expect(hostCmds[1]).toMatch(/--add .* (''|"")$/);
      expect(hostCmds[2]).toMatch(/--add .* '!ideaspaces credential'/);
      // Reset MUST precede our helper — otherwise osxkeychain still wins.
      const resetIdx = commands.indexOf(hostCmds[1]);
      const addIdx = commands.indexOf(hostCmds[2]);
      expect(resetIdx).toBeLessThan(addIdx);
    }
  });

  it("swallows errors silently (best-effort)", async () => {
    execMock.mockImplementation(() => {
      throw new Error("git: command not found");
    });

    // Must not throw — user can still type API key manually at prompt.
    await expect(registerGitCredentialHelper()).resolves.toBeUndefined();
  });

  it("tolerates --unset-all returning non-zero when the key is missing", async () => {
    // --unset-all exits 5 when no matching section/key exists. Our code
    // catches that specifically so the rest of the sequence runs.
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--unset-all")) {
        return Promise.reject(new Error("exit code 5"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await expect(registerGitCredentialHelper()).resolves.toBeUndefined();

    // Downstream --add calls still ran despite the --unset-all rejection.
    const addCalls = execMock.mock.calls.filter((c) =>
      (c[0] as string).includes("--add"),
    );
    expect(addCalls.length).toBeGreaterThanOrEqual(4); // 2 hosts × 2 --add calls
  });
});
