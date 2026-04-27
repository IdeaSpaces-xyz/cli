import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommand } from "../commands/create.js";
import type { GlobalFlags } from "../types.js";

const baseGlobal: GlobalFlags = {
  json: true, // suppress human output during tests
  quiet: true,
  yes: false,
  help: false,
};

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-create-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

function configureGitIdentity(cwd: string): void {
  spawnSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", cwd, "config", "user.name", "Test"]);
}

describe("ideaspaces create", () => {
  it("plans without applying when --yes is absent", async () => {
    const exit = await createCommand.run([], {}, baseGlobal);
    expect(exit).toBe(0);
    expect(existsSync(join(tmp, "_agent"))).toBe(false);
  });

  it("scaffolds greenfield with --yes", async () => {
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    configureGitIdentity(tmp); // git-init happened; ensure identity for any subsequent ops
    for (const file of ["foundation", "guide", "purpose", "now", "next"]) {
      expect(existsSync(join(tmp, "_agent", `${file}.md`))).toBe(true);
    }
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmp, ".gitignore"))).toBe(true);
    expect(existsSync(join(tmp, ".git"))).toBe(true);
  });

  it("creates `./<name>/` and scaffolds inside it", async () => {
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run(["my-space"], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    expect(existsSync(join(tmp, "my-space", "_agent", "foundation.md"))).toBe(true);
    expect(existsSync(join(tmp, "my-space", ".git"))).toBe(true);
    expect(existsSync(join(tmp, "my-space", "CLAUDE.md"))).toBe(true);
  });

  it("refuses when target is already a complete ideaspace", async () => {
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent", "foundation.md"), "# Foundation", "utf-8");
    await fs.writeFile(join(tmp, "CLAUDE.md"), "# CLAUDE", "utf-8");
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(5);
    // foundation untouched
    expect((await fs.readFile(join(tmp, "_agent", "foundation.md"), "utf-8")).trim()).toBe("# Foundation");
  });

  it("refuses on legacy _agent/ shape", async () => {
    await fs.mkdir(join(tmp, "_agent"), { recursive: true });
    await fs.writeFile(join(tmp, "_agent", "always.md"), "# legacy", "utf-8");
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(5);
  });

  it("detects code-repo signal and gitignores _agent/ by default (private)", async () => {
    await fs.writeFile(join(tmp, "package.json"), '{"name":"t"}', "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore).toContain("_agent/");
    expect(gitignore).toContain("CLAUDE.local.md");
    // CLAUDE.local.md instead of CLAUDE.md when private
    expect(existsSync(join(tmp, "CLAUDE.local.md"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("opts into shared _agent/ for code repo with --shared", async () => {
    await fs.writeFile(join(tmp, "package.json"), '{"name":"t"}', "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], { shared: true }, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("_agent/\n");
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.local.md"))).toBe(false);
  });

  it("appends to an existing .gitignore under # ideaspace defaults", async () => {
    await fs.writeFile(join(tmp, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
    spawnSync("git", ["config", "--global", "user.email", "test@example.com"]);
    spawnSync("git", ["config", "--global", "user.name", "Test"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    const gitignore = await fs.readFile(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(gitignore).toContain("# ideaspace defaults");
  });

  it("does not re-init git when target is already a repo", async () => {
    spawnSync("git", ["-C", tmp, "init", "-q", "-b", "main"]);
    configureGitIdentity(tmp);
    await fs.writeFile(join(tmp, "README.md"), "# existing", "utf-8");
    spawnSync("git", ["-C", tmp, "add", "."]);
    spawnSync("git", ["-C", tmp, "commit", "-q", "-m", "first"]);
    const exit = await createCommand.run([], {}, { ...baseGlobal, yes: true });
    expect(exit).toBe(0);
    // Two commits now: initial "first" + scaffold
    const log = spawnSync("git", ["-C", tmp, "log", "--oneline"], { encoding: "utf-8" });
    expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });
});
