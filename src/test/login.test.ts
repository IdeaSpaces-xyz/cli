import { afterEach, describe, expect, it, vi } from "vitest";

const { execMock, platformMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  platformMock: vi.fn(),
}));

vi.mock("node:child_process", async (importActual) => ({
  ...(await importActual<typeof import("node:child_process")>()),
  exec: execMock,
}));
vi.mock("node:os", async (importActual) => ({
  ...(await importActual<typeof import("node:os")>()),
  platform: platformMock,
}));

const { buildCliLoginUrl, openBrowser } = await import("../commands/login.js");

describe("buildCliLoginUrl", () => {
  afterEach(() => {
    delete process.env.IS_WEB_URL;
  });

  it("opens the web provider chooser with the callback port", () => {
    expect(buildCliLoginUrl("https://api.ideaspaces.xyz", 43210)).toBe(
      "https://ideaspaces.xyz/login?response_type=cli&port=43210",
    );
  });

  it("respects the configured web origin", () => {
    process.env.IS_WEB_URL = "http://localhost:5173";

    expect(buildCliLoginUrl("http://localhost:8000", 43123)).toBe(
      "http://localhost:5173/login?response_type=cli&port=43123",
    );
  });
});

describe("openBrowser", () => {
  const url = "https://ideaspaces.xyz/login?response_type=cli&port=43210";

  afterEach(() => {
    execMock.mockReset();
    platformMock.mockReset();
  });

  it("passes an empty title placeholder to Windows' `start`, so the URL is the target and not the window title", () => {
    // `start`'s first quoted argument is the new console window's title, not the
    // target — without an empty title placeholder, `start "<url>"` opens an empty
    // console instead of the browser (the bug this test guards against).
    platformMock.mockReturnValue("win32");

    openBrowser(url);

    expect(execMock).toHaveBeenCalledWith(`start "" "${url}"`);
  });

  it("uses `open` on macOS", () => {
    platformMock.mockReturnValue("darwin");

    openBrowser(url);

    expect(execMock).toHaveBeenCalledWith(`open "${url}"`);
  });

  it("uses `xdg-open` elsewhere", () => {
    platformMock.mockReturnValue("linux");

    openBrowser(url);

    expect(execMock).toHaveBeenCalledWith(`xdg-open "${url}"`);
  });
});
