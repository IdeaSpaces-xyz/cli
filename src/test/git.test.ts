import { afterEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { gitAvailability, gitAvailable, GIT_MISSING_HINT, GIT_UNUSABLE_HINT } from "../git.js";

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

async function pathDirectory(
  stub?: { stdout?: string; stderr?: string; exitCode?: number },
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "is-cli-git-availability-"));
  temporaryDirectories.push(directory);
  if (stub !== undefined) {
    const windows = process.platform === "win32";
    const executable = join(directory, windows ? "git.exe" : "git");
    if (windows) {
      if (stub.stdout) {
        const installedGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf-8" })
          .stdout.split(/\r?\n/)
          .find(Boolean);
        if (!installedGit) throw new Error("Windows test runner has no git.exe");
        return dirname(installedGit);
      } else {
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot) throw new Error("Windows test runner has no SystemRoot");
        await copyFile(join(systemRoot, "System32", "where.exe"), executable);
      }
    } else {
      const lines = [
        "#!/bin/sh",
        ...(stub.stdout ? [`printf '%s\\n' '${stub.stdout}'`] : []),
        ...(stub.stderr ? [`printf '%s\\n' '${stub.stderr}' >&2`] : []),
        `exit ${stub.exitCode ?? 0}`,
      ];
      await writeFile(executable, `${lines.join("\n")}\n`, "utf-8");
      await chmod(executable, 0o755);
    }
  }
  return directory;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("git availability", () => {
  it("reports an executable absent from PATH", async () => {
    process.env.PATH = await pathDirectory();

    expect(gitAvailability()).toEqual({ state: "absent", hint: GIT_MISSING_HINT });
    expect(gitAvailable()).toBe(false);
  });

  it("reports a present executable that exits nonzero as unusable", async () => {
    process.env.PATH = await pathDirectory({
      stderr: "xcrun: error: active developer path is missing",
      exitCode: 69,
    });

    const availability = gitAvailability();
    expect(availability).toMatchObject({
      state: "unusable",
      hint: GIT_UNUSABLE_HINT,
    });
    if (availability.state === "unusable") {
      expect(availability.detail).toBeTruthy();
      expect(availability.exitCode).not.toBe(0);
    }
    expect(gitAvailable()).toBe(false);
    expect(GIT_UNUSABLE_HINT).toContain("xcode-select --install");
  });

  it("reports a zero-exit executable and its version", async () => {
    const stubDirectory = await pathDirectory({ stdout: "git version 2.48.0" });
    process.env.PATH = process.platform === "win32"
      ? [stubDirectory, originalPath].filter(Boolean).join(delimiter)
      : stubDirectory;

    expect(gitAvailability()).toMatchObject({ state: "usable", version: expect.stringMatching(/^git version /) });
    expect(gitAvailable()).toBe(true);
  });
});
