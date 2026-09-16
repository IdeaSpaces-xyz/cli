import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMap } from "@ideaspaces/protocol";
import { loadConfig } from "../auth/credentials.js";
import { searchCommand } from "../commands/search.js";
import { projectSearchMap, searchMapLine } from "../search-map.js";
import { captureJson, captureStdout } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

vi.mock("../auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/credentials.js")>()),
  loadConfig: vi.fn(() => null),
}));

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const ROOT_NODE_ID = "n_0123456789abcdef01234567";

let root: string;
let originalCwd: string;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function search(query: string) {
  const { exit, json } = await captureJson(() => searchCommand.run([query], {}, G));
  expect(exit).toBe(0);
  return json;
}

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-search-map-")));
  originalCwd = process.cwd();
  process.chdir(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "search@example.com"]);
  git(["config", "user.name", "Search Test"]);
  await fs.mkdir(join(root, "_agent"), { recursive: true });
  await fs.writeFile(
    join(root, "_agent", "agreement.md"),
    `---\nroot_node_id: ${ROOT_NODE_ID}\n---\n# Agreement\n`,
  );
  await fs.mkdir(join(root, "notes"), { recursive: true });
  await fs.writeFile(
    join(root, "notes", "decision.md"),
    "---\nname: Decision\nsummary: The selected boundary.\n---\n# Decision\n\nThe awareness loop holds.\n",
  );
  await fs.writeFile(join(root, "notes", "loop.md"), "# Loop\n\nAn awareness loop, twice: awareness loop.\n");
  await fs.writeFile(join(root, "other.md"), "# Other\n\nNothing here.\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
  vi.mocked(loadConfig).mockReturnValue(null);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

describe("search emits a portable Map", () => {
  it("seals ranked hits in result order at a clean, pinned, identified HEAD", async () => {
    const data = await search("awareness loop");
    expect(data.total).toBe(2);
    expect(data.map_status).toBe("available");
    expect(data.dirty).toBe(false);
    const sha = git(["rev-parse", "HEAD"]);
    expect(data.map).toEqual({
      roots: [{ sha, root_node_id: ROOT_NODE_ID }],
      members: data.results.map((r: { path: string }) => ({
        root: 0,
        position: r.path,
        depth: "summary",
        disclosure: r.path === "notes/decision.md"
          ? { name: "Decision", summary: "The selected boundary." }
          : { name: "loop", summary: expect.any(String) },
      })),
    });
    // Rank stays in the operation result; the Map carries none of it.
    expect(JSON.stringify(data.map)).not.toMatch(/score|snippet|line|local_path/);
    // The Map is parse-valid as-is — what is_write receives, unchanged.
    expect(parseMap(data.map).status).toBe("valid");
    expect(data.root).toEqual({ local_path: root, sha, root_node_id: ROOT_NODE_ID });
  });

  it("keeps the full result and withholds the Map on a dirty tree", async () => {
    await fs.writeFile(join(root, "notes", "loop.md"), "# Loop\n\nawareness loop, edited\n");
    const data = await search("awareness loop");
    expect(data.total).toBe(2);
    expect(data).toMatchObject({ map_status: "projection_pending", map: null, dirty: true });
  });

  it("withholds the Map for an untracked hit", async () => {
    await fs.writeFile(join(root, "notes", "new.md"), "# New\n\nawareness loop\n");
    const data = await search("awareness loop");
    expect(data.results.map((r: { path: string }) => r.path)).toContain("notes/new.md");
    expect(data).toMatchObject({ map_status: "projection_pending", map: null, dirty: true });
  });

  it("withholds the Map without root identity", async () => {
    await fs.writeFile(join(root, "_agent", "agreement.md"), "# Agreement\n");
    git(["commit", "-qam", "drop identity"]);
    const data = await search("awareness");
    expect(data.total).toBe(2);
    expect(data).toMatchObject({ map_status: "projection_pending", map: null, dirty: false });
    expect(data.root).not.toHaveProperty("root_node_id");
  });

  it("withholds the Map on an unborn HEAD", async () => {
    const bare = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-search-unborn-")));
    try {
      process.chdir(bare);
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: bare });
      await fs.writeFile(join(bare, "a.md"), "# A\n\nawareness\n");
      const data = await search("awareness");
      expect(data.total).toBe(1);
      expect(data).toMatchObject({ map_status: "projection_pending", map: null });
      expect(data.root.sha).toBeNull();
    } finally {
      process.chdir(root);
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("fails closed when HEAD moves between the search and the seal", () => {
    const before = git(["rev-parse", "HEAD"]);
    const projection = projectSearchMap(root, before, ["notes/decision.md"], {
      headSha: () => "f".repeat(40),
    });
    expect(projection).toMatchObject({
      map_status: "projection_pending",
      map: null,
      portability_issue: "Git HEAD changed while verifying the portable Map",
    });
  });

  it("fails closed when a hit is not tracked at HEAD even though the tree reads clean", () => {
    const before = git(["rev-parse", "HEAD"]);
    const projection = projectSearchMap(root, before, ["notes/decision.md"], {
      trackedAt: () => new Set(["other.md"]),
    });
    expect(projection).toMatchObject({
      map_status: "projection_pending",
      portability_issue: "Not tracked at HEAD: notes/decision.md",
    });
  });

  it("withholds the Map when a hit cannot be read for disclosure", () => {
    const before = git(["rev-parse", "HEAD"]);
    const projection = projectSearchMap(root, before, ["notes/decision.md"], {
      readSource: () => {
        throw new Error("EACCES");
      },
    });
    expect(projection).toMatchObject({
      map_status: "projection_pending",
      map: null,
      portability_issue: "Could not read a hit for disclosure: EACCES",
    });
  });

  it("withholds the Map and reports issues when the built Map is invalid", () => {
    const before = git(["rev-parse", "HEAD"]);
    // A position that escapes the root is not a portable member.
    const projection = projectSearchMap(root, before, ["../outside.md"], {
      trackedAt: () => new Set(["../outside.md"]),
      readSource: () => "# Outside\n",
    });
    expect(projection.map_status).toBe("projection_pending");
    expect(projection.map).toBeNull();
    expect(projection.map_issues?.length).toBeGreaterThan(0);
  });

  it("says where the Map stands in human output", async () => {
    const clean = await captureStdout(() => searchCommand.run(["awareness"], {}, { ...G, json: false }));
    expect(clean.out).toContain(`Map: portable at ${git(["rev-parse", "HEAD"])}`);
    await fs.writeFile(join(root, "other.md"), "# Other\n\nchanged\n");
    const dirty = await captureStdout(() => searchCommand.run(["awareness"], {}, { ...G, json: false }));
    expect(dirty.out).toContain("Map: projection pending — working tree differs from HEAD");
    expect(searchMapLine({ map_status: "projection_pending", map: null, root: { local_path: root, sha: null }, dirty: false, local_only_paths: [] }))
      .toBe("Map: projection pending — the root has no committed pin");
  });

  it("emits an empty available Map when nothing matches at a clean pin", async () => {
    const data = await search("qwxyzq");
    expect(data.total).toBe(0);
    expect(data.map_status).toBe("available");
    expect(data.map.members).toEqual([]);
    expect(parseMap(data.map).status).toBe("valid");
  });
});
