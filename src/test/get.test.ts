import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";
import { captureJson, captureStdout } from "./helpers.js";

const { loadConfigMock, loadOptionalAuthConfigMock, fetchAuthMeMock, getSpaceMock, cloneRunMock, forkRunMock, linkRunMock } =
  vi.hoisted(() => ({
    loadConfigMock: vi.fn(),
    loadOptionalAuthConfigMock: vi.fn(),
    fetchAuthMeMock: vi.fn(),
    getSpaceMock: vi.fn(),
    cloneRunMock: vi.fn(),
    forkRunMock: vi.fn(),
    linkRunMock: vi.fn(),
  }));

vi.mock("../auth/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/credentials.js")>();
  return { ...actual, loadConfig: loadConfigMock, loadOptionalAuthConfig: loadOptionalAuthConfigMock };
});
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock, getSpace: getSpaceMock };
});
vi.mock("../commands/clone.js", () => ({ cloneCommand: { name: "clone", run: cloneRunMock } }));
vi.mock("../commands/fork.js", () => ({ forkCommand: { name: "fork", run: forkRunMock } }));
vi.mock("../commands/link.js", () => ({ linkCommand: { name: "link", run: linkRunMock } }));

const { getCommand } = await import("../commands/get.js");

const API = "https://example.test";
const ROOT = "n_0123456789abcdef01234567";
const URL = `${API}/repos/${ROOT}`;
const J: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const T: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

let tmp: string;
let stderr: string;
let restoreErr: typeof process.stderr.write;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-get-"));
  loadOptionalAuthConfigMock.mockReturnValue({ apiUrl: API });
  loadConfigMock.mockReturnValue(null);
  fetchAuthMeMock.mockReset();
  getSpaceMock.mockReset();
  cloneRunMock.mockReset().mockResolvedValue(0);
  forkRunMock.mockReset().mockResolvedValue(0);
  linkRunMock.mockReset().mockResolvedValue(0);
  stderr = "";
  restoreErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = restoreErr;
  await rm(tmp, { recursive: true, force: true });
});

function publicSpace(overrides: Partial<{ copy_enabled: boolean; login_required_to_copy: boolean }> = {}) {
  return {
    kind: "space", node_id: ROOT, container_node_id: "n_c", name: "Field Notes", canonical_url: URL,
    copy_enabled: true, login_required_to_copy: false, summary: null, readme_markdown: null, ...overrides,
  };
}

describe("get plans a Space URL", () => {
  it("shows both modes' truth for a public Space when logged out, and mutates nothing", async () => {
    getSpaceMock.mockResolvedValue(publicSpace());
    const { exit, json } = await captureJson(() => getCommand.run([URL], {}, J));
    expect(exit).toBe(0);
    expect(json).toMatchObject({
      kind: "space",
      root_node_id: ROOT,
      name: "Field Notes",
      canonical_url: URL,
      logged_in: false,
      modes: {
        clone: { available: false, fetch: "login required", push: "login required", history: "full" },
        fork: { available: true, copy: "allowed", history: "none" },
      },
    });
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
    expect(cloneRunMock).not.toHaveBeenCalled();
    expect(forkRunMock).not.toHaveBeenCalled();

    const { out } = await captureStdout(() => getCommand.run([URL], {}, T));
    expect(out).toContain("Collaborate on this Space (clone) — same identity, full history — not available");
    expect(out).toContain("Make my own version (fork) — new identity, no source history\n  copy:  allowed");
    expect(out).toContain("Nothing changed.");
    expect(out).toContain(`Choose one: ideaspaces get ${URL} --yes --as fork`);
  });

  it("reads clone truth from the account catalog when logged in", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: API, apiKey: "k" });
    loadOptionalAuthConfigMock.mockReturnValue({ apiUrl: API, apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      user_id: 1, username: "me", email: null, name: null, onboarding_complete: true,
      repos: [{ repo_id: "r1", root_node_id: ROOT, name: "Field Notes", actions: ["open", "clone"] }],
    });
    getSpaceMock.mockRejectedValue(new Error("GET /x → 404: private"));
    const { json } = await captureJson(() => getCommand.run([URL], {}, J));
    expect(json.modes.clone).toEqual({ available: true, fetch: "allowed", push: "not allowed", history: "full" });
    expect(json.modes.fork).toEqual({ available: false, copy: "not allowed", history: "none" });
  });

  it("keeps clone honest as unknown for a known-link collaborator without a catalog row", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: API, apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({ user_id: 1, username: "me", email: null, name: null, onboarding_complete: true, repos: [] });
    getSpaceMock.mockResolvedValue(publicSpace({ login_required_to_copy: true }));
    const { json } = await captureJson(() => getCommand.run([URL], {}, J));
    expect(json.modes.clone).toMatchObject({ available: true, fetch: "unknown", push: "unknown" });
    expect(json.modes.fork).toMatchObject({ available: true, copy: "allowed" });
  });
});

describe("get executes only a named mode", () => {
  it("refuses --yes without --as, and --as without --yes", async () => {
    getSpaceMock.mockResolvedValue(publicSpace());
    expect(await getCommand.run([URL], {}, { ...J, yes: true })).toBe(1);
    expect(stderr).toContain("--yes needs a mode: --as clone, --as fork, or --as link");
    stderr = "";
    expect(await getCommand.run([URL], { as: "fork" }, J)).toBe(1);
    expect(stderr).toContain("add --yes to run it");
    expect(forkRunMock).not.toHaveBeenCalled();
  });

  it("runs the mode's own command with the address and the rest of the arguments", async () => {
    getSpaceMock.mockResolvedValue(publicSpace());
    const global = { ...J, yes: true };
    expect(await getCommand.run([URL, "./mine"], { as: "fork", name: "Mine" }, global)).toBe(0);
    expect(forkRunMock).toHaveBeenCalledWith([URL, "./mine"], { as: "fork", name: "Mine" }, global);
    expect(cloneRunMock).not.toHaveBeenCalled();
  });

  it("refuses a mode the plan says is not available", async () => {
    getSpaceMock.mockResolvedValue(publicSpace({ copy_enabled: false }));
    expect(await getCommand.run([URL], { as: "fork" }, { ...J, yes: true })).toBe(1);
    expect(stderr).toContain("fork is not available here");
    expect(forkRunMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode and an address that is neither a URL nor a folder", async () => {
    expect(await getCommand.run([URL], { as: "steal" }, { ...J, yes: true })).toBe(1);
    expect(stderr).toContain("--as must be one of clone, fork, link");
    expect(await getCommand.run(["nowhere-such"], {}, J)).toBe(1);
    expect(stderr).toContain("Not a Space URL or an existing folder");
  });
});

describe("get plans a local folder", () => {
  function git(cwd: string, ...args: string[]) {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(r.stderr);
  }

  it("offers link only for a clone with an origin", async () => {
    const plain = join(tmp, "plain");
    await mkdir(plain);
    let { json } = await captureJson(() => getCommand.run([plain], {}, J));
    expect(json).toMatchObject({ kind: "folder", modes: { link: { available: false, reason: "not a git repository" } } });

    const noOrigin = join(tmp, "no-origin");
    await mkdir(noOrigin);
    git(noOrigin, "init", "-q", "-b", "main");
    ({ json } = await captureJson(() => getCommand.run([noOrigin], {}, J)));
    expect(json.modes.link).toMatchObject({ available: false, reason: expect.stringContaining("no `origin` remote") });

    const clone = join(tmp, "clone");
    await mkdir(clone);
    git(clone, "init", "-q", "-b", "main");
    git(clone, "remote", "add", "origin", "https://example.test/git/n_x.git");
    ({ json } = await captureJson(() => getCommand.run([clone], {}, J)));
    expect(json.modes.link).toEqual({ available: true, origin: "https://example.test/git/n_x.git" });
    expect(json.modes.clone).toBeUndefined();

    const global = { ...J, yes: true };
    expect(await getCommand.run([clone, "alice/notes"], { as: "link" }, global)).toBe(0);
    expect(linkRunMock).toHaveBeenCalledWith([clone, "alice/notes"], { as: "link" }, global);
    expect(await getCommand.run([clone], { as: "clone" }, global)).toBe(1);
    expect(stderr).toContain("--as clone does not apply to a local folder");
  });
});
