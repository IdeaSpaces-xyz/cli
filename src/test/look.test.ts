import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAP_DEPTHS, assembleContentLook, gitState, parseMap } from "@ideaspaces/protocol";
import { loadConfig } from "../auth/credentials.js";
import { lookCommand, projectPortableMap } from "../commands/look.js";
import type { GlobalFlags } from "../types.js";

vi.mock("../auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/credentials.js")>()),
  loadConfig: vi.fn(() => null),
}));

const JSON_FLAGS: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};
const ROOT_NODE_ID = "n_0123456789abcdef01234567";

let root: string;
let originalCwd: string;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function runLook(
  args: string[],
  flags: Record<string, string | boolean> = {},
  global: GlobalFlags = JSON_FLAGS,
): Promise<{ exit: number; data: any; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await lookCommand.run(args, flags, global);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  const out = stdout.join("");
  return {
    exit,
    data: global.json && out ? JSON.parse(out) : null,
    stdout: out,
    stderr: stderr.join(""),
  };
}

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-look-")));
  originalCwd = process.cwd();
  process.chdir(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "look@example.com"]);
  git(["config", "user.name", "Look Test"]);
  await fs.mkdir(join(root, "_agent"), { recursive: true });
  await fs.writeFile(
    join(root, "_agent", "agreement.md"),
    `---\nroot_node_id: ${ROOT_NODE_ID}\n---\n# Agreement\n\nAGREEMENT SENTINEL\n`,
  );
  await fs.writeFile(
    join(root, "_agent", "foundation.md"),
    `---\nroot_node_id: ${ROOT_NODE_ID}\nsummary: Foundation compatibility.\n---\n# Foundation\n\nFOUNDATION SENTINEL\n`,
  );
  await fs.mkdir(join(root, "notes"), { recursive: true });
  await fs.writeFile(
    join(root, "notes", "decision.md"),
    "---\nname: Decision\nsummary: The selected boundary.\n---\n# Decision\n\nBody.\n\n## Evidence\n\nProof.\n",
  );
  await fs.mkdir(join(root, "docs", "sub"), { recursive: true });
  await fs.writeFile(
    join(root, "docs", "README.md"),
    "---\nname: Documents\nsummary: Working documents.\n---\n# Documents\n\nStart here.\n",
  );
  await fs.writeFile(join(root, "docs", "alpha.md"), "---\nsummary: Alpha.\n---\n# Alpha\n");
  await fs.writeFile(join(root, "docs", "sub", "beta.md"), "# Beta\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
  vi.mocked(loadConfig).mockReturnValue(null);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

describe("ideaspaces look", () => {
  it("defaults to Agreement summary and emits one valid portable Map", async () => {
    const cwd = process.cwd();
    const result = await runLook(["notes/decision.md"]);

    expect(result.exit, result.stderr).toBe(0);
    expect(process.cwd()).toBe(cwd);
    expect(result.data).toMatchObject({
      kind: "content-look",
      source: "local-working-tree",
      depth: "summary",
      portable: true,
      dirty: false,
      local_only_paths: [],
      reference: {
        contractRole: "reference",
        contractSource: "agreement",
        tree: null,
      },
      target: {
        placement: "history",
        position: "notes/decision.md",
        depth: "summary",
        name: "Decision",
        summary: "The selected boundary.",
      },
      projection: {
        root: { root_node_id: ROOT_NODE_ID },
        member: { position: "notes/decision.md", depth: "summary" },
      },
      map: {
        roots: [{ root_node_id: ROOT_NODE_ID }],
        members: [{ root: 0, position: "notes/decision.md", depth: "summary" }],
      },
    });
    expect(result.data.projection.root.local_path).toBe(result.data.reference.position.repoRoot);
    expect(parseMap(result.data.map).status).toBe("valid");
    expect(result.data.text).toContain("contract role: reference — read, never composed");
    expect(result.data.text).toContain("AGREEMENT SENTINEL");
    expect(result.data.text).not.toContain("FOUNDATION SENTINEL");
  });

  it("passes all five canonical rungs through the protocol reader", async () => {
    for (const depth of MAP_DEPTHS) {
      const result = await runLook(["notes/decision.md"], { depth });
      expect(result.exit, `${depth}: ${result.stderr}`).toBe(0);
      expect(result.data.target.depth).toBe(depth);
      expect(result.data.target.member.depth).toBe(depth);
    }

    const children = await runLook(["notes/decision.md"], { depth: "children" });
    expect(children.data.target.children.map((child: { name: string }) => child.name))
      .toEqual(["Decision", "Evidence"]);
    expect(children.data.target).not.toHaveProperty("surface");

    const full = await runLook(["notes/decision.md"], { depth: "full" });
    expect(full.data.target.surface).toContain("# Decision");
    expect(full.data.target).not.toHaveProperty("children");
  }, 20_000);

  it("returns directory surface plus bounded children at full", async () => {
    const result = await runLook(["docs"], { depth: "full", limit: "1" });

    expect(result.exit, result.stderr).toBe(0);
    expect(result.data.target).toMatchObject({
      kind: "directory",
      name: "Documents",
      summary: "Working documents.",
      surface: "# Documents\n\nStart here.\n",
      omittedChildren: 1,
      children: [{ kind: "directory", name: "sub", position: "docs/sub" }],
    });
    expect(result.data.target.children.some((child: { name: string }) => child.name === "README.md"))
      .toBe(false);
  });

  it("keeps explicit Foundation selection isolated", async () => {
    const result = await runLook(["notes/decision.md"], { contract: "foundation" });

    expect(result.exit, result.stderr).toBe(0);
    expect(result.data.reference.contractSource).toBe("foundation");
    expect(result.data.text).toContain("Foundation compatibility.");
    expect(result.data.text).not.toContain("AGREEMENT SENTINEL");
  });

  it("does not treat an ignored but nonexistent README as observed local Content", async () => {
    await fs.writeFile(join(root, ".gitignore"), "README.md\n");
    await fs.mkdir(join(root, "without-readme"));
    await fs.writeFile(join(root, "without-readme", "child.md"), "# Child\n");
    git(["add", ".gitignore", "without-readme/child.md"]);
    git(["commit", "-q", "-m", "add directory without a surface"]);

    const result = await runLook(["without-readme"], { depth: "children" });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.data).toMatchObject({
      portable: true,
      dirty: false,
      local_only_paths: [],
    });
    expect(result.data.target).not.toHaveProperty("surface");
    expect(result.data.map).toBeDefined();
  });

  it("fails closed to a local projection when the root is dirty or the target is ignored", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Changed\n");
    const dirty = await runLook(["notes/decision.md"], { depth: "full" });
    expect(dirty.exit, dirty.stderr).toBe(0);
    expect(dirty.data).toMatchObject({ portable: false, dirty: true });
    expect(dirty.data).not.toHaveProperty("map");

    git(["checkout", "--", "notes/decision.md"]);
    await fs.writeFile(join(root, ".gitignore"), "ignored.md\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "ignore local note"]);
    await fs.writeFile(join(root, "ignored.md"), "# Private\n");
    const ignored = await runLook(["ignored.md"], { depth: "name" });
    expect(ignored.exit, ignored.stderr).toBe(0);
    expect(ignored.data).toMatchObject({
      portable: false,
      dirty: true,
      local_only_paths: ["ignored.md"],
    });
    expect(ignored.data).not.toHaveProperty("map");
  });

  it("surfaces portability state in human output", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Changed\n");
    const result = await runLook(
      ["notes/decision.md"],
      { depth: "full" },
      { ...JSON_FLAGS, json: false, quiet: false },
    );

    expect(result.exit, result.stderr).toBe(0);
    expect(result.stdout).toContain("Look:\n  position: notes/decision.md");
    expect(result.stdout).toContain(
      "Map: local projection only — working tree differs from HEAD",
    );
  });

  it("fails portable projection closed when HEAD changes during verification", async () => {
    const looked = await assembleContentLook({
      position: join(root, "notes", "decision.md"),
      depth: "summary",
      contractSource: "agreement",
    });
    expect(looked?.status).toBe("ok");
    if (!looked || looked.status !== "ok") return;
    const actual = await gitState(root);
    let reads = 0;
    const projection = await projectPortableMap(looked, {
      readGitState: async () => ({
        ...actual,
        headSha: reads++ === 0 ? actual.headSha : "f".repeat(40),
      }),
    });

    expect(projection).toMatchObject({
      portable: false,
      issue: "The target or Git HEAD changed while verifying the portable Map",
    });
    expect(projection).not.toHaveProperty("map");
  });

  it("reports invalid, remote, missing, and non-Content targets through the error channel", async () => {
    expect((await runLook(["notes/decision.md"], { depth: "deep" })).stderr)
      .toContain("--depth must be one of");
    expect((await runLook(["notes/decision.md"], { contract: "both" })).stderr)
      .toContain("--contract must be");
    expect((await runLook(["https://ideaspaces.xyz/repos/n_example"])).stderr)
      .toContain("Remote look is not available yet");
    expect((await runLook(["missing.md"])).stderr).toContain("No such path");
    expect((await runLook(["_agent/agreement.md"])).stderr).toContain("Not a Content target");
    await fs.writeFile(join(root, "data.txt"), "plain data");
    expect((await runLook(["data.txt"])).stderr).toContain("Not a Content target");
  });
});
