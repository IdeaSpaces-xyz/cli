import { afterEach, describe, expect, it } from "vitest";
import { buildCliLoginUrl } from "../commands/login.js";

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
