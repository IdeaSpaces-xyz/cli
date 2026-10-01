import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentCommand } from "../commands/agent.js";
import { agentsCommand } from "../commands/agents.js";
import { saveSpace } from "../auth/spaces.js";
import { projectMapAgents, formatMapAgentsText } from "../local/map-agents.js";
import { loadMapNote } from "../local/map-note.js";

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function initGitRepo(dir: string): string {
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Test Author"]);
  runGit(dir, ["config", "user.email", "test@ideaspaces.xyz"]);
  return dir;
}

function commitFile(dir: string, relPath: string, content: string, message = "initial"): string {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  runGit(dir, ["add", relPath]);
  runGit(dir, ["commit", "-m", message]);
  const rev = runGit(dir, ["rev-parse", "HEAD"]);
  return rev.stdout.trim();
}

describe("agent list — Map-derived agent discovery (S1)", () => {
  let tempBase: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "is-agent-list-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempBase;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempBase, { recursive: true, force: true });
  });

    function makeRepo(name: string): string {
    const dir = join(tempBase, name);
    mkdirSync(dir, { recursive: true });
    initGitRepo(dir);
    try {
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  }

  it("projects only included agent-kind roots in Map order with their full kind references", async () => {
    // Root 0: Agent A
    const repoA = makeRepo("agent-a");
    const idA = "n_0935a5df1f883eeb60bcdfbb";
    const shaA = commitFile(
      repoA,
      "_agent/agreement.md",
      `---
name: Agent A
summary: TypeScript integrator agent
root_node_id: ${idA}
agreement: agent:repo:${idA}
---
# Agent A
`,
    );
    saveSpace(repoA, {
      repo_id: "repo_a",
      slug: "agent-a",
      namespace: "test",
      root_node_id: idA,
    });

    // Root 1: Agent B
    const repoB = makeRepo("agent-b");
    const idB = "n_1234567890abcdef12345678";
    const shaB = commitFile(
      repoB,
      "_agent/agreement.md",
      `---
name: Agent B
summary: Scout agent
root_node_id: ${idB}
agreement: agent:repo:${idB}
---
# Agent B
`,
    );
    saveSpace(repoB, {
      repo_id: "repo_b",
      slug: "agent-b",
      namespace: "test",
      root_node_id: idB,
    });

    // Root 2: Knowledge Root
    const repoK = makeRepo("knowledge-k");
    const idK = "n_f1511280efecd7fcff155152";
    const shaK = commitFile(
      repoK,
      "_agent/agreement.md",
      `---
name: Docs Knowledge
summary: Documentation space
root_node_id: ${idK}
agreement: knowledge:repo:${idK}
---
# Docs
`,
    );
    saveSpace(repoK, {
      repo_id: "repo_k",
      slug: "knowledge-k",
      namespace: "test",
      root_node_id: idK,
    });

    // Root 3: Unknown-kind Root (no agent:repo: declaration)
    const repoU = makeRepo("unknown-u");
    const idU = "n_aaaaaaaaaaaaaaaaaaaaaaaa";
    const shaU = commitFile(
      repoU,
      "_agent/agreement.md",
      `---
name: Untyped Space
summary: No declared kind
root_node_id: ${idU}
---
# Untyped Space
`,
    );
    saveSpace(repoU, {
      repo_id: "repo_u",
      slug: "unknown-u",
      namespace: "test",
      root_node_id: idU,
    });

    // Root 4: Unused Agent C (in roots, but not in members)
    const repoC = makeRepo("agent-c");
    const idC = "n_999999999999999999999999";
    const shaC = commitFile(
      repoC,
      "_agent/agreement.md",
      `---
name: Agent C
summary: Unused agent
root_node_id: ${idC}
agreement: agent:repo:${idC}
---
# Agent C
`,
    );
    saveSpace(repoC, {
      repo_id: "repo_c",
      slug: "agent-c",
      namespace: "test",
      root_node_id: idC,
    });

    // Create .map.md with members referencing roots 0, 2, 3, 1 (Agent A, Knowledge, Unknown, Agent B)
    const mapPath = join(tempBase, "space.map.md");
    writeFileSync(
      mapPath,
      `---
name: Multi Space Map
summary: Test Map fixture
map:
  roots:
    - root_node_id: ${idA}
      sha: ${shaA}
    - root_node_id: ${idB}
      sha: ${shaB}
    - root_node_id: ${idK}
      sha: ${shaK}
    - root_node_id: ${idU}
      sha: ${shaU}
    - root_node_id: ${idC}
      sha: ${shaC}
  members:
    - root: 0
      position: .
      depth: summary
    - root: 2
      position: .
      depth: summary
    - root: 3
      position: .
      depth: summary
    - root: 1
      position: .
      depth: summary
---
# Legend
Space map legend.
`,
      "utf-8",
    );

    const loadedMap = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loadedMap, { cwd: tempBase });
    expect(result.unresolved).toHaveLength(0);
    expect(result.agents).toHaveLength(2);

    // Order matches Map member order (Agent A first, Agent B second)
    expect(result.agents[0]).toEqual({
      name: "Agent A",
      summary: "TypeScript integrator agent",
      agreement: `agent:repo:${idA}`,
      root_node_id: idA,
      sha: shaA,
      path: repoA,
      position: ".",
    });

    expect(result.agents[1]).toEqual({
      name: "Agent B",
      summary: "Scout agent",
      agreement: `agent:repo:${idB}`,
      root_node_id: idB,
      sha: shaB,
      path: repoB,
      position: ".",
    });

    // Verify text output
    const text = formatMapAgentsText(result);
    expect(text).toContain("Agent A (agent:repo:n_0935a5df1f883eeb60bcdfbb)");
    expect(text).toContain("Agent B (agent:repo:n_1234567890abcdef12345678)");
    expect(text).not.toContain("Agent C");
    expect(text).not.toContain("Docs Knowledge");
    expect(text).not.toContain("Untyped Space");

    // Also run via agentCommand
    let capturedData: any = null;
    let capturedTextOutput = "";
    const mockGlobal = {
      json: true,
      quiet: false,
      yes: false,
      help: false,
      repo: tempBase,
    };
    const exitCode = await agentCommand.run(
      ["list"],
      { map: "space.map.md" },
      mockGlobal,
    );
    expect(exitCode).toBe(0);
  }, 30_000); // Windows Git process startup can exceed Vitest's 5s default for this many repositories.

  it("dynamically changes the agent list when the Map selection changes without editing a second roster", () => {
    const repoA = makeRepo("agent-a");
    const idA = "n_0935a5df1f883eeb60bcdfbb";
    const shaA = commitFile(
      repoA,
      "_agent/agreement.md",
      `---
name: Agent A
root_node_id: ${idA}
agreement: agent:repo:${idA}
---
`,
    );
    saveSpace(repoA, { repo_id: "repo_a", slug: "agent-a", namespace: "test", root_node_id: idA });

    const repoC = makeRepo("agent-c");
    const idC = "n_999999999999999999999999";
    const shaC = commitFile(
      repoC,
      "_agent/agreement.md",
      `---
name: Agent C
root_node_id: ${idC}
agreement: agent:repo:${idC}
---
`,
    );
    saveSpace(repoC, { repo_id: "repo_c", slug: "agent-c", namespace: "test", root_node_id: idC });

    const mapPath = join(tempBase, "space.map.md");
    // Initial Map: only root 0 (Agent A) in members
    writeFileSync(
      mapPath,
      `---
name: Dynamic Map
map:
  roots:
    - root_node_id: ${idA}
      sha: ${shaA}
    - root_node_id: ${idC}
      sha: ${shaC}
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    let loaded = loadMapNote(mapPath, tempBase);
    let result = projectMapAgents(loaded, { cwd: tempBase });
    expect(result.agents.map((a) => a.name)).toEqual(["Agent A"]);

    // Edit Map note: change member to root 1 (Agent C)
    writeFileSync(
      mapPath,
      `---
name: Dynamic Map
map:
  roots:
    - root_node_id: ${idA}
      sha: ${shaA}
    - root_node_id: ${idC}
      sha: ${shaC}
  members:
    - root: 1
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    loaded = loadMapNote(mapPath, tempBase);
    result = projectMapAgents(loaded, { cwd: tempBase });
    expect(result.agents.map((a) => a.name)).toEqual(["Agent C"]);
  });

  it("reports an unavailable pin visibly as unresolved without network request or HEAD substitution", () => {
    const repoA = makeRepo("agent-a");
    const idA = "n_0935a5df1f883eeb60bcdfbb";
    commitFile(
      repoA,
      "_agent/agreement.md",
      `---
name: Agent A HEAD
root_node_id: ${idA}
agreement: agent:repo:${idA}
---
`,
    );
    saveSpace(repoA, { repo_id: "repo_a", slug: "agent-a", namespace: "test", root_node_id: idA });

    const missingSha = "0123456789abcdef0123456789abcdef01234567";
    const mapPath = join(tempBase, "unavailable.map.md");
    writeFileSync(
      mapPath,
      `---
name: Unavailable Pin Map
map:
  roots:
    - root_node_id: ${idA}
      sha: ${missingSha}
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    const loaded = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loaded, { cwd: tempBase });

    expect(result.agents).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({
      root_node_id: idA,
      sha: missingSha,
      reason: "unavailable_pin",
    });

    const text = formatMapAgentsText(result);
    expect(text).toContain("Unresolved roots:");
    expect(text).toContain("pin unavailable (01234567)");
  });

  it("reports an unbound root visibly as unresolved", () => {
    const idUnbound = "n_bbbbbbbbbbbbbbbbbbbbbbbb";
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const mapPath = join(tempBase, "unbound.map.md");
    writeFileSync(
      mapPath,
      `---
name: Unbound Root Map
map:
  roots:
    - root_node_id: ${idUnbound}
      sha: ${sha}
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    const loaded = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loaded, { cwd: tempBase });

    expect(result.agents).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({
      root_node_id: idUnbound,
      sha,
      reason: "unbound",
    });

    const text = formatMapAgentsText(result);
    expect(text).toContain("Unresolved roots:");
    expect(text).toContain("unbound (no local checkout)");
  });

  it("inspects the exact pin commit rather than HEAD or worktree changes", () => {
    const repoA = makeRepo("agent-a");
    const idA = "n_0935a5df1f883eeb60bcdfbb";
    // Pin commit: valid agent
    const shaPin = commitFile(
      repoA,
      "_agent/agreement.md",
      `---
name: Agent At Pin
summary: Pinned as agent
root_node_id: ${idA}
agreement: agent:repo:${idA}
---
`,
      "pinned commit",
    );

    // Later commit at HEAD: changed to knowledge kind
    commitFile(
      repoA,
      "_agent/agreement.md",
      `---
name: Knowledge Space at HEAD
summary: Changed to knowledge
root_node_id: ${idA}
agreement: knowledge:repo:n_f1511280efecd7fcff155152
---
`,
      "head commit",
    );

    saveSpace(repoA, { repo_id: "repo_a", slug: "agent-a", namespace: "test", root_node_id: idA });

    const mapPath = join(tempBase, "pinned.map.md");
    writeFileSync(
      mapPath,
      `---
name: Pinned Map
map:
  roots:
    - root_node_id: ${idA}
      sha: ${shaPin}
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    const loaded = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loaded, { cwd: tempBase });

    // Inspecting at shaPin finds the agent, ignoring the HEAD change!
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Agent At Pin");
    expect(result.agents[0].agreement).toBe(`agent:repo:${idA}`);
    expect(result.agents[0].sha).toBe(shaPin);
  });

  it("does not include roots with _agent/ but no agent:repo: declaration", () => {
    const repoF = makeRepo("foundation-space");
    const idF = "n_444444444444444444444444";
    const shaF = commitFile(
      repoF,
      "_agent/foundation.md",
      `---
name: Foundation Space
root_node_id: ${idF}
---
# Foundation
`,
    );
    saveSpace(repoF, { repo_id: "repo_f", slug: "foundation-space", namespace: "test", root_node_id: idF });

    const mapPath = join(tempBase, "foundation.map.md");
    writeFileSync(
      mapPath,
      `---
name: Foundation Map
map:
  roots:
    - root_node_id: ${idF}
      sha: ${shaF}
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    const loaded = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loaded, { cwd: tempBase });

    expect(result.agents).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
  });

  it("reports a git error for corrupted or non-git registered checkouts as unresolved", () => {
    const nonGitDir = join(tempBase, "not-a-git-repo");
    mkdirSync(nonGitDir, { recursive: true });
    const idE = "n_eeeeeeeeeeeeeeeeeeeeeeee";
    saveSpace(nonGitDir, { repo_id: "repo_e", slug: "not-a-git-repo", namespace: "test", root_node_id: idE });

    const mapPath = join(tempBase, "giterror.map.md");
    writeFileSync(
      mapPath,
      `---
name: Git Error Map
map:
  roots:
    - root_node_id: ${idE}
      sha: 0123456789abcdef0123456789abcdef01234567
  members:
    - root: 0
      position: .
      depth: summary
---
`,
      "utf-8",
    );

    const loaded = loadMapNote(mapPath, tempBase);
    const result = projectMapAgents(loaded, { cwd: tempBase });

    expect(result.agents).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].root_node_id).toBe(idE);
    expect(result.unresolved[0].reason).toBe("git_error");
    expect(formatMapAgentsText(result)).toContain("git error:");
  });

  it("preserves the existing hosted ideaspaces agents command definition and usage", () => {
    expect(agentsCommand.name).toBe("agents");
    expect(agentsCommand.usage).toContain("ideaspaces agents");
    expect(agentCommand.name).toBe("agent");
    expect(agentCommand.usage).toContain("list --map <file>");
  });

  it("validates required --map flag and reports errors honestly", async () => {
    const fakeOutput = {
      json: false,
      quiet: false,
      yes: false,
      help: false,
    };

    // Missing --map
    const exitCode1 = await agentCommand.run(["list"], {}, fakeOutput);
    expect(exitCode1).toBe(1);

    // Invalid subcommand
    const exitCode2 = await agentCommand.run(["unknown"], { map: "some.map.md" }, fakeOutput);
    expect(exitCode2).toBe(1);

    // Non-existent map file
    const exitCode3 = await agentCommand.run(["list"], { map: join(tempBase, "missing.map.md") }, fakeOutput);
    expect(exitCode3).toBe(1);
  });
});
