import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { signOutMock, clearMock } = vi.hoisted(() => ({ signOutMock: vi.fn(), clearMock: vi.fn() }));
vi.mock("../auth/client-session.js", () => ({ signOut: signOutMock }));
vi.mock("../auth/session-state.js", () => ({ clearSessionState: clearMock }));
import { logoutCommand } from "../commands/power/logout.js";
const flags = { json: true, quiet: false, yes: false, help: false };
beforeEach(() => { signOutMock.mockReset(); clearMock.mockReset(); vi.stubEnv("IS_API_KEY", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["Sign-in storage is locked; wait and retry.", "EACCES: credential store is not writable", "Could not connect to IdeaSpaces (request was not sent)."])("keeps the actual sign-out cause visible: %s", async message => {
  signOutMock.mockRejectedValue(new Error(message));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await logoutCommand.run([], {}, flags)).toBe(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(stdout).not.toHaveBeenCalled(); expect(clearMock).not.toHaveBeenCalled();
});
it("reports successful sign-out and an explicit env override without exposing it", async () => {
  signOutMock.mockResolvedValue(undefined); vi.stubEnv("IS_API_KEY", "test-only-env-secret");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await logoutCommand.run([], {}, flags)).toBe(0);
  const text = stdout.mock.calls.map(c => c[0]).join("");
  expect(JSON.parse(text)).toEqual({ logged_out: true, env_override_active: true });
  expect(text).not.toContain("test-only-env-secret"); expect(clearMock).toHaveBeenCalledOnce();
});
