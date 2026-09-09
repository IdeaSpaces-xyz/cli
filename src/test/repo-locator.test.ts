import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalGitUrl,
  canonicalRepoUrl,
  parseRepoLocator,
  repoRouteNamespace,
  rootNodeIdFromGitUrl,
} from "../repo-locator.js";

afterEach(() => {
  delete process.env.IS_WEB_URL;
  delete process.env.IS_GIT_URL;
});

const ROOT = "n_0123456789abcdef01234567";

describe("canonical repo locator", () => {
  it("parses an exact locator on the configured web host", () => {
    expect(
      parseRepoLocator(`https://ideaspaces.xyz/repos/${ROOT}`, "https://api.ideaspaces.xyz"),
    ).toEqual({
      rootNodeId: ROOT,
      canonicalUrl: `https://ideaspaces.xyz/repos/${ROOT}`,
    });
  });

  it("answers a legacy /spaces link with the canonical repo URL", () => {
    expect(
      parseRepoLocator(`https://ideaspaces.xyz/spaces/${ROOT}`, "https://api.ideaspaces.xyz"),
    ).toEqual({
      rootNodeId: ROOT,
      canonicalUrl: `https://ideaspaces.xyz/repos/${ROOT}`,
    });
  });

  it.each([
    `https://evil.test/repos/${ROOT}`,
    `https://ideaspaces.xyz/repos/${ROOT}?next=https://evil.test`,
    `https://ideaspaces.xyz/repos/${ROOT}/tree`,
    `https://ideaspaces.xyz/repos/not-a-node`,
    `https://ideaspaces.xyz/spaces/not-a-node`,
    `file:///repos/${ROOT}`,
  ])("rejects non-canonical or unconfigured input: %s", (value) => {
    expect(() => parseRepoLocator(value, "https://api.ideaspaces.xyz")).toThrow();
  });

  it("resolves both transport forms, and only on the configured Git host", () => {
    const api = "https://api.ideaspaces.xyz";
    expect(rootNodeIdFromGitUrl(`https://git.ideaspaces.xyz/repos/${ROOT}.git`, api)).toBe(ROOT);
    expect(rootNodeIdFromGitUrl(`https://git.ideaspaces.xyz/spaces/${ROOT}.git`, api)).toBe(ROOT);
    expect(rootNodeIdFromGitUrl(`git@git.ideaspaces.xyz:repos/${ROOT}.git`, api)).toBe(ROOT);
    expect(rootNodeIdFromGitUrl(`https://evil.test/repos/${ROOT}.git`, api)).toBeNull();
  });

  it("honors configured web and Git overrides", () => {
    process.env.IS_WEB_URL = "http://web.localhost:9000";
    process.env.IS_GIT_URL = "http://git.localhost:9001";

    expect(canonicalRepoUrl("http://api.localhost:8000", ROOT)).toBe(
      `http://web.localhost:9000/repos/${ROOT}`,
    );
    expect(canonicalGitUrl("http://api.localhost:8000", ROOT)).toBe(
      `http://git.localhost:9001/repos/${ROOT}.git`,
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
          receipt_classes: ["person_owner"],
          actions: ["open", "copy", "clone", "collaborate"],
          route_status: "conflict",
          route_namespace: null,
        },
        "alice",
      ),
    ).toBeNull();
  });
});
