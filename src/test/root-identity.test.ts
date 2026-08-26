import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { declareRootIdentity, inspectLocalRootIdentity } from "../root-identity.js";
import { saveSpace } from "../auth/spaces.js";

const ROOT_A = "n_0123456789abcdef01234567";
const ROOT_B = "n_aaaaaaaaaaaaaaaaaaaaaaaa";

let tmp: string;
let repo: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "is-cli-root-identity-"));
  repo = join(tmp, "space");
  mkdirSync(repo);
  originalHome = process.env.HOME;
  originalApiUrl = process.env.IS_API_URL;
  process.env.HOME = tmp;
  process.env.IS_API_URL = "https://api.example.test";
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# Space\n");
  spawnSync("git", ["-C", repo, "add", "README.md"]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalApiUrl === undefined) delete process.env.IS_API_URL;
  else process.env.IS_API_URL = originalApiUrl;
  rmSync(tmp, { recursive: true, force: true });
});

function foundation(rootNodeId: string): string {
  return `---\nname: Test\nsummary: Test Space.\nroot_node_id: ${rootNodeId}\n---\n\n# Foundation\n`;
}

function commitFoundation(content: string): void {
  mkdirSync(join(repo, "_agent"), { recursive: true });
  writeFileSync(join(repo, "_agent", "foundation.md"), content);
  spawnSync("git", ["-C", repo, "add", "_agent/foundation.md"]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "declare identity"]);
}

describe("local root identity", () => {
  it("adds a declaration without reformatting existing frontmatter", () => {
    const source = "---\r\nname: Test\r\ncustom: keep\r\n---\r\n\r\n# Foundation\r\n";
    expect(declareRootIdentity(source, ROOT_A)).toBe(
      `---\r\nname: Test\r\ncustom: keep\r\nroot_node_id: ${ROOT_A}\r\n---\r\n\r\n# Foundation\r\n`,
    );
    expect(() => declareRootIdentity(foundation(ROOT_A), ROOT_B)).toThrow(/replace/);
  });

  it("reports a committed declaration as local-only without network or registry", () => {
    commitFoundation(foundation(ROOT_A));
    const report = inspectLocalRootIdentity(repo);
    expect(report).toMatchObject({
      state: "local_only",
      root_node_id: ROOT_A,
      canonical_origin: null,
      local_registry: null,
      declaration: { head: ROOT_A, index: ROOT_A, worktree: ROOT_A, dirty: false },
    });
  });

  it("aligns committed declaration, canonical origin, and registry evidence", () => {
    commitFoundation(foundation(ROOT_A));
    spawnSync("git", ["-C", repo, "remote", "add", "origin", `https://git.example.test/spaces/${ROOT_A}.git`]);
    saveSpace(repo, {
      kind: "hosted",
      repo_id: "repo_a",
      slug: "space",
      namespace: "alice",
      root_node_id: ROOT_A,
    });

    expect(inspectLocalRootIdentity(repo)).toMatchObject({
      state: "aligned",
      root_node_id: ROOT_A,
      canonical_origin: ROOT_A,
      local_registry: ROOT_A,
      declaration: { dirty: false },
    });
  });

  it("detects a staged identity change even when the worktree was restored", () => {
    commitFoundation(foundation(ROOT_A));
    writeFileSync(join(repo, "_agent", "foundation.md"), foundation(ROOT_B));
    spawnSync("git", ["-C", repo, "add", "_agent/foundation.md"]);
    writeFileSync(join(repo, "_agent", "foundation.md"), foundation(ROOT_A));

    expect(inspectLocalRootIdentity(repo)).toMatchObject({
      state: "local_only",
      root_node_id: ROOT_A,
      declaration: { head: ROOT_A, index: ROOT_B, worktree: ROOT_A, dirty: true },
    });
  });

  it("reports drift without selecting an identity", () => {
    commitFoundation(foundation(ROOT_A));
    saveSpace(repo, {
      kind: "hosted",
      repo_id: "repo_b",
      slug: "space",
      namespace: "alice",
      root_node_id: ROOT_B,
    });

    expect(inspectLocalRootIdentity(repo)).toMatchObject({
      state: "drift",
      root_node_id: null,
      local_registry: ROOT_B,
    });
  });

  it("reports a canonical legacy clone without a declaration as legacy-unstamped", () => {
    spawnSync("git", ["-C", repo, "remote", "add", "origin", `https://git.example.test/spaces/${ROOT_A}.git`]);
    expect(inspectLocalRootIdentity(repo)).toMatchObject({
      state: "legacy_unstamped",
      root_node_id: ROOT_A,
      canonical_origin: ROOT_A,
      declaration: { head: null, index: null, worktree: null, dirty: false },
    });
  });

  it("fails closed on malformed committed foundation frontmatter", () => {
    commitFoundation("---\nroot_node_id: [\n---\n\n# Foundation\n");
    const report = inspectLocalRootIdentity(repo);
    expect(report.state).toBe("invalid");
    expect(report.root_node_id).toBeNull();
    expect(readFileSync(join(repo, "_agent", "foundation.md"), "utf-8")).toContain("root_node_id: [");
  });
});
