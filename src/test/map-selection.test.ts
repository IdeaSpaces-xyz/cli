import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, resolveSpaceBindingMock, originUrlMock, fetchContentTreeMock, fetchEntityMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  resolveSpaceBindingMock: vi.fn(),
  originUrlMock: vi.fn(),
  fetchContentTreeMock: vi.fn(),
  fetchEntityMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/resolve-space.js", () => ({ resolveSpaceBinding: resolveSpaceBindingMock }));
vi.mock("../auth/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/api.js")>(),
  fetchContentTree: fetchContentTreeMock,
  fetchEntity: fetchEntityMock,
}));
vi.mock("../git.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../git.js")>(),
  originUrl: originUrlMock,
}));

const { mapCommand } = await import("../commands/map.js");

const ROOT_NODE_ID = "n_0123456789abcdef01234567";
const TARGET_NODE_ID = "n_abcdefabcdefabcdefabcdef";
const GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let root: string;
let remote: string;
let originalCwd: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

function git(args: string[], cwd = root): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function run(note = "notes/finding.md") {
  stdoutChunks = [];
  stderrChunks = [];
  const code = await mapCommand.run(
    ["select", note],
    {
      hostname: "example.com",
      "note-depth": "surface",
      "note-name": "Why this Note",
      "entity-summary": "The company in question",
    },
    GLOBAL,
  );
  const stdout = stdoutChunks.join("");
  return { code, stdout, stderr: stderrChunks.join(""), data: stdout ? JSON.parse(stdout) : null };
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "is-cli-map-select-")));
  remote = realpathSync.native(mkdtempSync(join(tmpdir(), "is-cli-map-select-remote-")));
  git(["init", "-q", "--bare", remote], "/");
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "map@example.com"]);
  git(["config", "user.name", "Map Selection Test"]);
  mkdirSync(join(root, "notes"));
  writeFileSync(
    join(root, "notes", "finding.md"),
    "---\nname: Finding\nsummary: Observed at the selected pin.\n---\n# Finding\n\nExact body.\n",
  );
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "main"]);
  process.chdir(root);

  loadConfigMock.mockReset().mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
  resolveSpaceBindingMock.mockReset().mockResolvedValue({ rootNodeId: ROOT_NODE_ID, via: "origin" });
  originUrlMock.mockReset().mockReturnValue(`https://git.example.test/repos/${ROOT_NODE_ID}.git`);
  fetchContentTreeMock.mockReset().mockResolvedValue({
    kind: "content_tree",
    target_node_id: ROOT_NODE_ID,
    target_type: "repo",
    root_node_id: ROOT_NODE_ID,
    hosted_history_available: true,
    path: "notes",
    node_id: null,
    name: "Notes",
    summary: null,
    children: [{
      name: "finding.md",
      type: "file",
      path: "notes/finding.md",
      node_id: TARGET_NODE_ID,
      node_type: "note",
      name_display: "Finding",
      summary: "Observed at the selected pin.",
    }],
  });
  fetchEntityMock.mockReset().mockResolvedValue({
    node_id: "n_111111111111111111111111",
    entity_type: "hostname",
    entity_key: "example.com",
    name: "Example",
    summary: "Current entity summary.",
    content: "",
  });

  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe("ideaspaces map select", () => {
  it("builds the fixed Note plus hostname selection without local bindings", async () => {
    const result = await run();

    expect(result.code, result.stderr).toBe(0);
    expect(result.data).toEqual({
      kind: "exchange-map-selection",
      target_node_id: TARGET_NODE_ID,
      map: {
        roots: [{
          repo: `https://example.test/repos/${ROOT_NODE_ID}`,
          root_node_id: ROOT_NODE_ID,
          sha: git(["rev-parse", "HEAD"]),
        }],
        members: [
          {
            root: 0,
            position: "notes/finding.md",
            depth: "surface",
            name: "Why this Note",
            disclosure: { name: "Finding", summary: "Observed at the selected pin." },
          },
          {
            address: "hostname:example.com",
            depth: "summary",
            summary: "The company in question",
            disclosure: { name: "Example", summary: "Current entity summary." },
          },
        ],
      },
    });
    expect(result.stdout).not.toContain(root);
    expect(JSON.stringify(result.data)).not.toContain("local_path");
  });

  it("refuses dirty, local-only, and unpublished selected content", async () => {
    writeFileSync(join(root, "notes", "finding.md"), "changed outside HEAD\n");
    let result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("differs from HEAD");
    expect(fetchContentTreeMock).not.toHaveBeenCalled();

    git(["restore", "notes/finding.md"]);
    writeFileSync(join(root, "notes", "local.md"), "# Local\n");
    result = await run("notes/local.md");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("local-only");

    resolveSpaceBindingMock.mockResolvedValue({ failure: "unpublished" });
    result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Publish it before");

    resolveSpaceBindingMock.mockResolvedValue({ failure: "identity-entrypoint-conflict" });
    result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Agreement and Foundation declare different root identities");
  });

  it("refuses a clean commit that is absent from the remote branch", async () => {
    writeFileSync(join(root, "notes", "finding.md"), "---\nname: Later\nsummary: Not pushed.\n---\n# Later\n");
    git(["add", "notes/finding.md"]);
    git(["commit", "-q", "-m", "local only commit"]);

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not published at origin/main");
    expect(fetchContentTreeMock).not.toHaveBeenCalled();
  });

  it("requires exact hosted history and indexed path resolution", async () => {
    fetchContentTreeMock.mockResolvedValue({
      root_node_id: ROOT_NODE_ID,
      hosted_history_available: false,
      children: [],
    });
    let result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Hosted history is not available");

    fetchContentTreeMock.mockResolvedValue({
      root_node_id: ROOT_NODE_ID,
      hosted_history_available: true,
      children: [],
    });
    result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("absent or ambiguous in the hosted index");
  });
});
