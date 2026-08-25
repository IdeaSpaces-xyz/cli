import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAvailability, gitAvailable, GIT_MISSING_HINT, GIT_UNUSABLE_HINT } from "../git.js";

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

async function pathDirectory(gitScript?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "is-cli-git-availability-"));
  temporaryDirectories.push(directory);
  if (gitScript !== undefined) {
    const executable = join(directory, "git");
    await writeFile(executable, `#!/bin/sh\n${gitScript}\n`, "utf-8");
    await chmod(executable, 0o755);
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
    process.env.PATH = await pathDirectory(
      'printf "%s\\n" "xcrun: error: active developer path is missing" >&2\nexit 69',
    );

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
    process.env.PATH = await pathDirectory('printf "%s\\n" "git version 2.48.0"');

    expect(gitAvailability()).toEqual({ state: "usable", version: "git version 2.48.0" });
    expect(gitAvailable()).toBe(true);
  });
});
