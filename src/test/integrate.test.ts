import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";
import { captureJson } from "./helpers.js";

const { findSpaceForMock, updateRunMock } = vi.hoisted(() => ({
  findSpaceForMock: vi.fn(),
  updateRunMock: vi.fn(),
}));
vi.mock("../auth/spaces.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/spaces.js")>();
  return { ...actual, findSpaceFor: findSpaceForMock };
});
vi.mock("../commands/update.js", () => ({ updateCommand: { name: "update", run: updateRunMock } }));

const { integrateCommand, planIntegrate } = await import("../commands/integrate.js");

const J: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

describe("planIntegrate — the channel follows the checkout", () => {
  const fork = { kind: "unpublished_fork", root_node_id: "n_a", name: "a", source_root_node_id: "n_s", source_head: "h", source_baseline_initialized: true } as const;
  const hosted = { kind: "hosted", repo_id: "r", slug: "s", namespace: "me" } as const;
  const published = { ...hosted, source_root_node_id: "n_s", source_head: "h" } as const;

  it("pulls a hosted clone, updates an unpublished fork", () => {
    expect(planIntegrate(hosted, "origin/main")).toMatchObject({ from: "remote" });
    expect(planIntegrate(fork, null)).toMatchObject({ from: "source" });
    expect(planIntegrate(fork, "origin/main")).toMatchObject({ from: "source" });
  });

  it("defaults a published fork to its own remote and names the source as the other", () => {
    expect(planIntegrate(published, "origin/main")).toMatchObject({ from: "remote", also: "source" });
    expect(planIntegrate(published, "origin/main", "source")).toMatchObject({ from: "source" });
    expect(planIntegrate(published, null)).toMatchObject({ from: "source" });
  });

  it("refuses when the asked channel or any channel is absent", () => {
    expect(planIntegrate(hosted, null)).toMatchObject({ error: expect.stringContaining("Nothing to integrate from") });
    expect(planIntegrate(hosted, "origin/main", "source")).toMatchObject({ error: expect.stringContaining("no maintained source") });
    expect(planIntegrate(fork, null, "remote")).toMatchObject({ error: expect.stringContaining("No upstream") });
    expect(planIntegrate(null, null)).toMatchObject({ error: expect.any(String) });
  });
});

describe("integrate runs the channel's own command, plan-first", () => {
  let root: string;
  let stderr = "";
  let restore: typeof process.stderr.write;
  // pull --yes registers the git credential helper at --global scope; HOME is
  // sandboxed so the test never writes the person's real ~/.gitconfig.
  let prevHome: string | undefined;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "is-integrate-"));
    prevHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    await mkdir(process.env.HOME);
    const bare = join(root, "remote.git");
    git(root, "init", "--bare", "-q", "-b", "main", bare);
    git(root, "clone", "-q", bare, "a");
    git(join(root, "a"), "config", "user.email", "a@t");
    git(join(root, "a"), "config", "user.name", "A");
    writeFileSync(join(root, "a", "f.md"), "one\n");
    git(join(root, "a"), "add", ".");
    git(join(root, "a"), "commit", "-qm", "one");
    git(join(root, "a"), "push", "-q", "-u", "origin", "main");
    git(root, "clone", "-q", bare, "b");
    git(join(root, "b"), "config", "user.email", "b@t");
    git(join(root, "b"), "config", "user.name", "B");
    writeFileSync(join(root, "a", "f.md"), "two\n");
    git(join(root, "a"), "commit", "-qam", "two");
    git(join(root, "a"), "push", "-q");
    findSpaceForMock.mockReset().mockReturnValue({ kind: "hosted", repo_id: "r", slug: "s", namespace: "me" });
    updateRunMock.mockReset().mockResolvedValue(0);
    stderr = "";
    restore = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = restore;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  });

  async function inB<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.cwd();
    process.chdir(join(root, "b"));
    try {
      return await fn();
    } finally {
      process.chdir(orig);
    }
  }

  it("plans a clone's upstream without touching it, then pulls with --yes", async () => {
    const plan = await inB(() => captureJson(() => integrateCommand.run([], {}, J)));
    expect(plan.exit).toBe(0);
    expect(plan.json).toMatchObject({ dry_run: true, upstream: "origin/main" });
    expect(git(join(root, "b"), "log", "--oneline", "-1")).toContain("one");

    const done = await inB(() => captureJson(() => integrateCommand.run([], {}, { ...J, yes: true })));
    expect(done.exit).toBe(0);
    expect(done.json).toMatchObject({ upstream: "origin/main", integrated: 1 });
    expect(git(join(root, "b"), "log", "--oneline", "-1")).toContain("two");
    expect(updateRunMock).not.toHaveBeenCalled();
    // The helper registration landed in the sandboxed HOME, nowhere else.
    expect(spawnSync("git", ["config", "--global", "--get-all", "credential.https://git.ideaspaces.xyz.helper"], { encoding: "utf-8", env: { ...process.env } }).stdout).toContain("credential");
  });

  it("routes an unpublished fork to update, passing --yes through", async () => {
    findSpaceForMock.mockReturnValue({ kind: "unpublished_fork", root_node_id: "n_a", name: "a", source_root_node_id: "n_s", source_head: "h", source_baseline_initialized: true });
    const global = { ...J, yes: true };
    expect(await inB(() => integrateCommand.run([], {}, global))).toBe(0);
    expect(updateRunMock).toHaveBeenCalledWith([], {}, global);
  });

  it("refuses an unknown --from and a checkout with no channel", async () => {
    expect(await inB(() => integrateCommand.run([], { from: "moon" }, J))).toBe(1);
    expect(stderr).toContain("--from must be `remote` or `source`");
    findSpaceForMock.mockReturnValue(null);
    git(join(root, "b"), "branch", "--unset-upstream");
    expect(await inB(() => integrateCommand.run([], {}, J))).toBe(1);
    expect(stderr).toContain("Nothing to integrate from");
  });
});
