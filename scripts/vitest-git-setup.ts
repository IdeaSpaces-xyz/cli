// A fresh Git config pair for each test, independent of HOME and the app session.
import { afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let dir: string;
let previousGlobal: string | undefined;
let previousSystem: string | undefined;
beforeEach(() => {
  previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  previousSystem = process.env.GIT_CONFIG_SYSTEM;
  dir = mkdtempSync(join(tmpdir(), "is-test-git-"));
  const global = join(dir, "global.gitconfig");
  const system = join(dir, "system.gitconfig");
  writeFileSync(global, ""); writeFileSync(system, "");
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_SYSTEM = system;
});
afterEach(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = previousSystem;
  rmSync(dir, { recursive: true, force: true });
});
