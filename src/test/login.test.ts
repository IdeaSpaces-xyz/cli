import { afterEach, describe, expect, it, vi } from "vitest";
const { execMock, platformMock } = vi.hoisted(() => ({ execMock: vi.fn(), platformMock: vi.fn() }));
vi.mock("node:child_process", async (actual) => ({ ...(await actual<typeof import("node:child_process")>()), execFile: execMock }));
vi.mock("node:os", async (actual) => ({ ...(await actual<typeof import("node:os")>()), platform: platformMock }));
const { buildCliLoginUrl, openBrowser } = await import("../commands/login.js");
afterEach(() => { delete process.env.IS_WEB_URL; vi.clearAllMocks(); });
describe("CLI PKCE browser start", () => {
  it("uses the API authorize route with client=cli and only a challenge, never the verifier", () => {
    process.env.IS_WEB_URL = "https://not-the-api.invalid";
    const u = new URL(buildCliLoginUrl("https://api.ideaspaces.xyz", { port: 43210, state: "random-state", challenge: "challenge", installId: "test-install", deviceName: "CLI test device" }));
    expect(u.origin + u.pathname).toBe("https://api.ideaspaces.xyz/auth/desktop/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client: "cli", redirect_uri: "http://127.0.0.1:43210/callback", state: "random-state", code_challenge: "challenge", code_challenge_method: "S256", install_id: "test-install", device_name: "CLI test device" });
    expect(u.searchParams.has("code_verifier")).toBe(false);
  });
  it.each([["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", "https://test.invalid/?x=1&y=2"]], ["darwin", "open", ["https://test.invalid/?x=1&y=2"]], ["linux", "xdg-open", ["https://test.invalid/?x=1&y=2"]]])("opens safely on %s without shell interpolation", async (os, command, args) => {
    platformMock.mockReturnValue(os); execMock.mockImplementation((_c, _a, cb) => cb(null));
    await openBrowser("https://test.invalid/?x=1&y=2");
    expect(execMock).toHaveBeenCalledWith(command, args, expect.any(Function));
  });
});
