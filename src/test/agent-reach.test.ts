import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgentReach } from "../local/agent-reach.js";

const roots: string[] = [];
function tempDir(prefix = "agent-reach-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("discoverAgentReach", () => {
  it("discovers enclosing space root for a sub-POV", () => {
    const space = tempDir("space-");
    spawnSync("git", ["init", "-q", "-b", "main", space]);
    mkdirSync(join(space, "_threads"));
    const pov = join(space, "agents", "scout");
    mkdirSync(join(pov, "_agent"), { recursive: true });
    writeFileSync(join(pov, "_agent", "agreement.md"), "# Scout Agreement\n");

    const result = discoverAgentReach({ povPath: pov });
    expect(result.errors).toEqual([]);
    expect(result.addedDirs).toEqual([realpathSync.native(space)]);
  });

  it("finds Home when POV is itself a nested Git repo", () => {
    const home = tempDir("home-");
    spawnSync("git", ["init", "-q", "-b", "main", home]);
    mkdirSync(join(home, "_threads"));
    const pov = join(home, "agents", "scout");
    mkdirSync(join(pov, "_agent"), { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", pov]);
    writeFileSync(join(pov, "_agent", "agreement.md"), "# Scout\n");
    expect(discoverAgentReach({ povPath: pov }).addedDirs).toEqual([realpathSync.native(home)]);
  });

  it("stops at the nearest parent Git root without _threads", () => {
    const outer = tempDir("outer-");
    spawnSync("git", ["init", "-q", "-b", "main", outer]);
    mkdirSync(join(outer, "_threads"));
    const inner = join(outer, "inner");
    mkdirSync(inner);
    spawnSync("git", ["init", "-q", "-b", "main", inner]);
    const pov = join(inner, "scout");
    mkdirSync(pov);
    spawnSync("git", ["init", "-q", "-b", "main", pov]);
    expect(discoverAgentReach({ povPath: pov }).addedDirs).toEqual([]);
  });

  it("handles standalone POV without enclosing space root", () => {
    const pov = tempDir("pov-");
    mkdirSync(join(pov, "_agent"), { recursive: true });
    writeFileSync(join(pov, "_agent", "agreement.md"), "# Agreement\n");

    const result = discoverAgentReach({ povPath: pov });
    expect(result.errors).toEqual([]);
    expect(result.addedDirs).toEqual([]);
  });

  it("discovers checkouts referenced in the Space Map", () => {
    const space = tempDir("space-");
    spawnSync("git", ["init", "-q", "-b", "main", space]);
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: space });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: space });
    mkdirSync(join(space, "_threads"));
    const pov = join(space, "agents", "scout");
    mkdirSync(join(pov, "_agent"), { recursive: true });
    writeFileSync(join(pov, "_agent", "agreement.md"), "# Scout Agreement\n");

    const extRepo = join(space, "ext-repo");
    spawnSync("git", ["init", "-q", "-b", "main", extRepo]);
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: extRepo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: extRepo });
    mkdirSync(join(extRepo, "_agent"), { recursive: true });
    writeFileSync(join(extRepo, "_agent", "foundation.md"), "---\nname: Lib\nroot_node_id: n_111111111111111111111111\n---\n# Lib\n");
    spawnSync("git", ["add", "."], { cwd: extRepo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: extRepo });

    const extSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: extRepo, encoding: "utf8" }).stdout.trim();

    const mapContent = `---
name: Home
summary: The Space.
map:
  roots:
    - root_node_id: n_111111111111111111111111
      sha: "${extSha}"
  members:
    - root: 0
      position: README.md
      depth: summary
---
# Space Map
`;
    writeFileSync(join(space, "home.map.md"), mapContent);
    spawnSync("git", ["add", "."], { cwd: space });
    spawnSync("git", ["commit", "-m", "init"], { cwd: space });

    const result = discoverAgentReach({ povPath: pov });
    expect(result.errors).toEqual([]);
    expect(result.addedDirs).toContain(realpathSync.native(space));
    expect(result.addedDirs).toContain(realpathSync.native(extRepo));
  });

  it("warns when a discovered Map is malformed or names an unavailable checkout", () => {
    const pov = tempDir("pov-");
    writeFileSync(join(pov, "home.map.md"), "---\nname: Broken\nmap: invalid\n---\n");
    const broken = discoverAgentReach({ povPath: pov });
    expect(broken.errors).toEqual([]);
    expect(broken.warnings[0]).toContain("home.map.md");
    writeFileSync(join(pov, "home.map.md"), `---\nname: Home\nmap:\n  roots:\n    - root_node_id: n_aaaaaaaaaaaaaaaaaaaaaaaa\n      sha: "${"a".repeat(40)}"\n  members: []\n---\n# Home\n`);
    const missing = discoverAgentReach({ povPath: pov });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings[0]).toContain("no local checkout");
    expect(missing.addedDirs).toEqual([]);
  });

  it("refuses an explicitly selected malformed Map", () => {
    const pov = tempDir("pov-");
    writeFileSync(join(pov, "broken.map.md"), "---\nname: Broken\nmap: invalid\n---\n");
    const result = discoverAgentReach({ povPath: pov, mapFlag: "broken.map.md" });
    expect(result.errors[0]).toContain("Cannot grant reach from --map");
  });

  it("reports a moved POV without throwing", () => {
    const result = discoverAgentReach({ povPath: "/nonexistent/pov" });
    expect(result.errors[0]).toContain("Cannot resolve POV");
  });

  it("validates and adds explicit --reach directories", () => {
    const pov = tempDir("pov-");
    const other1 = tempDir("reach1-");
    const other2 = tempDir("reach2-");

    const result = discoverAgentReach({ povPath: pov, reachFlag: [other1, other2] });
    expect(result.errors).toEqual([]);
    expect(result.addedDirs).toEqual([realpathSync.native(other1), realpathSync.native(other2)]);
  });

  it("resolves relative, comma-containing and symlinked reach exactly once", () => {
    const pov = tempDir("pov-");
    const caller = tempDir("caller-");
    const target = join(caller, "repo,one");
    mkdirSync(target);
    symlinkSync(target, join(caller, "shortcut"), "dir");
    const result = discoverAgentReach({ povPath: pov, cwd: caller, reachFlag: ["shortcut", "repo,one"] });
    expect(result.errors).toEqual([]);
    expect(result.addedDirs).toEqual([realpathSync.native(target)]);
  });

  it("reports errors for non-existent --reach directories", () => {
    const pov = tempDir("pov-");
    const result = discoverAgentReach({ povPath: pov, reachFlag: "/nonexistent/dir" });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("directory not found");
  });
});
