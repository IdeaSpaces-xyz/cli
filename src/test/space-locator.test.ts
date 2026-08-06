import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalGitUrl,
  canonicalSpaceUrl,
  parseSpaceLocator,
  repoRouteNamespace,
} from "../space-locator.js";

afterEach(() => {
  delete process.env.IS_WEB_URL;
  delete process.env.IS_GIT_URL;
});

const ROOT = "n_0123456789abcdef01234567";

describe("canonical Space locator", () => {
  it("parses an exact locator on the configured web host", () => {
    expect(
      parseSpaceLocator(`https://ideaspaces.xyz/spaces/${ROOT}`, "https://api.ideaspaces.xyz"),
    ).toEqual({
      rootNodeId: ROOT,
      canonicalUrl: `https://ideaspaces.xyz/spaces/${ROOT}`,
    });
  });

  it.each([
    `https://evil.test/spaces/${ROOT}`,
    `https://ideaspaces.xyz/spaces/${ROOT}?next=https://evil.test`,
    `https://ideaspaces.xyz/spaces/${ROOT}/tree`,
    `https://ideaspaces.xyz/spaces/not-a-node`,
    `file:///spaces/${ROOT}`,
  ])("rejects non-canonical or unconfigured input: %s", (value) => {
    expect(() => parseSpaceLocator(value, "https://api.ideaspaces.xyz")).toThrow();
  });

  it("honors configured web and Git overrides", () => {
    process.env.IS_WEB_URL = "http://web.localhost:9000";
    process.env.IS_GIT_URL = "http://git.localhost:9001";

    expect(canonicalSpaceUrl("http://api.localhost:8000", ROOT)).toBe(
      `http://web.localhost:9000/spaces/${ROOT}`,
    );
    expect(canonicalGitUrl("http://api.localhost:8000", ROOT)).toBe(
      `http://git.localhost:9001/spaces/${ROOT}.git`,
    );
  });

  it("does not infer a namespace when an explicit route is unresolved", () => {
    expect(
      repoRouteNamespace(
        {
          repo_id: "r1",
          root_node_id: ROOT,
          slug: "notes",
          hostname: "acme.com",
          role: "OWNER",
          member_count: 1,
          route_status: "conflict",
          route_namespace: null,
        },
        "alice",
      ),
    ).toBeNull();
  });
});
