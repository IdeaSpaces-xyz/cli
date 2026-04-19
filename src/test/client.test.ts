/**
 * Tests for initClient — the --repo flag resolution path.
 *
 * Pre-fix: initClient passed flags.repo straight to createClient as repo_id,
 * so `--repo <slug>` produced URLs like /repos/notes/tree → 400 "Invalid repo_id format".
 * Post-fix: slug/hostname/hostname-slug all resolve via listRepos first.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GlobalFlags } from "../types.js";

const { createClientMock, loadConfigMock, autoSelectRepoMock, mockClient, listReposMock, setRepoMock } =
  vi.hoisted(() => {
    const listReposMock = vi.fn();
    const setRepoMock = vi.fn();
    const mockClient = {
      listRepos: listReposMock,
      setRepo: setRepoMock,
      get repoId() {
        return "";
      },
    };
    const createClientMock = vi.fn(() => mockClient);
    const loadConfigMock = vi.fn();
    const autoSelectRepoMock = vi.fn();
    return {
      createClientMock,
      loadConfigMock,
      autoSelectRepoMock,
      mockClient,
      listReposMock,
      setRepoMock,
    };
  });

vi.mock("@ideaspaces/sdk", () => ({
  createClient: createClientMock,
  autoSelectRepo: autoSelectRepoMock,
}));

vi.mock("../auth/credentials.js", () => ({
  loadConfig: loadConfigMock,
}));

const { initClient } = await import("../client.js");

const FLAGS: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

const REPOS = [
  {
    repo_id: "repo_aaaa11112222",
    slug: "notes",
    hostname: null,
    role: "OWNER",
    name: "My Notes",
  },
  {
    repo_id: "repo_bbbb33334444",
    slug: "notes",
    hostname: "ideaspaces.xyz",
    role: "MEMBER",
    name: "Org Notes",
  },
  {
    repo_id: "repo_cccc55556666",
    slug: "work",
    hostname: "stripe.com",
    role: "MEMBER",
    name: "Work Notes",
  },
];

beforeEach(() => {
  loadConfigMock.mockReset();
  listReposMock.mockReset();
  setRepoMock.mockReset();
  autoSelectRepoMock.mockReset();
  createClientMock.mockClear();
});

describe("initClient — flags.repo is a repo_id", () => {
  it("uses the repo_id verbatim without calling listRepos", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });

    await initClient({ ...FLAGS, repo: "repo_aaaa11112222" });

    expect(listReposMock).not.toHaveBeenCalled();
    expect(setRepoMock).toHaveBeenCalledWith("repo_aaaa11112222");
  });
});

describe("initClient — flags.repo is a slug/hostname (needs resolution)", () => {
  it("resolves a bare slug to the personal repo's repo_id", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({ data: { repos: REPOS } });

    await initClient({ ...FLAGS, repo: "notes" });

    expect(listReposMock).toHaveBeenCalled();
    expect(setRepoMock).toHaveBeenCalledWith("repo_aaaa11112222");
  });

  it("resolves hostname/slug to the hostname repo's repo_id", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({ data: { repos: REPOS } });

    await initClient({ ...FLAGS, repo: "ideaspaces.xyz/notes" });

    expect(setRepoMock).toHaveBeenCalledWith("repo_bbbb33334444");
  });

  it("resolves a bare hostname (single hostname repo) to that repo_id", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({ data: { repos: REPOS } });

    await initClient({ ...FLAGS, repo: "stripe.com" });

    expect(setRepoMock).toHaveBeenCalledWith("repo_cccc55556666");
  });

  it("errors with a listing when the slug doesn't match any repo", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    listReposMock.mockResolvedValue({ data: { repos: REPOS } });

    await expect(
      initClient({ ...FLAGS, repo: "does-not-exist" }),
    ).rejects.toThrow(/Space "does-not-exist" not found/);
    expect(setRepoMock).not.toHaveBeenCalled();
  });
});

describe("initClient — default resolution paths", () => {
  it("uses config.repo when flags.repo is absent", async () => {
    loadConfigMock.mockReturnValue({
      apiKey: "k",
      apiUrl: "u",
      repo: "repo_aaaa11112222",
    });

    await initClient(FLAGS);

    expect(listReposMock).not.toHaveBeenCalled();
    expect(setRepoMock).toHaveBeenCalledWith("repo_aaaa11112222");
  });

  it("throws when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    await expect(initClient(FLAGS)).rejects.toThrow(/Not logged in/);
  });

  it("auto-selects when only one repo is available", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    autoSelectRepoMock.mockResolvedValue({
      repoId: "repo_aaaa11112222",
      repos: [REPOS[0]],
    });

    await initClient(FLAGS);

    expect(autoSelectRepoMock).toHaveBeenCalled();
  });

  it("errors with a listing when multiple repos and no flag/default", async () => {
    loadConfigMock.mockReturnValue({ apiKey: "k", apiUrl: "u", repo: "" });
    autoSelectRepoMock.mockResolvedValue({ repoId: null, repos: REPOS });

    await expect(initClient(FLAGS)).rejects.toThrow(/Multiple spaces available/);
  });
});
