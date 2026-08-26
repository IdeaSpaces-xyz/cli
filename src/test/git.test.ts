import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const executable = join(directory, windows ? "git.cmd" : "git");
    const lines = windows
      ? [
          "@echo off",
          ...(stub.stdout ? [`echo ${stub.stdout}`] : []),
          ...(stub.stderr ? [`echo ${stub.stderr} 1>&2`] : []),
          `exit /b ${stub.exitCode ?? 0}`,
        ]
      : [
          "#!/bin/sh",
          ...(stub.stdout ? [`printf '%s\\n' '${stub.stdout}'`] : []),
          ...(stub.stderr ? [`printf '%s\\n' '${stub.stderr}' >&2`] : []),
          `exit ${stub.exitCode ?? 0}`,
        ];
    await writeFile(executable, `${lines.join("\n")}\n`, "utf-8");
    if (!windows) await chmod(executable, 0o755);
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

    expect(gitAvailability()).toEqual({
      state: "unusable",
      hint: GIT_UNUSABLE_HINT,
      detail: "xcrun: error: active developer path is missing",
      exitCode: 69,
    });
    expect(gitAvailable()).toBe(false);
    expect(GIT_UNUSABLE_HINT).toContain("xcode-select --install");
  });

  it("reports a zero-exit executable and its version", async () => {
    process.env.PATH = await pathDirectory({ stdout: "git version 2.48.0" });

    expect(gitAvailability()).toEqual({ state: "usable", version: "git version 2.48.0" });
    expect(gitAvailable()).toBe(true);
  });
});
