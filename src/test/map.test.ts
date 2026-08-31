import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAP_DEPTHS, parseMap } from "@ideaspaces/protocol";
import { mapCommand } from "../commands/map.js";
import type { GlobalFlags } from "../types.js";

const JSON_FLAGS: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};

let root: string;
let originalCwd: string;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function runMap(
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
    exit = await mapCommand.run(args, flags, global);
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
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-derived-map-")));
  originalCwd = process.cwd();
  process.chdir(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "map@example.com"]);
  git(["config", "user.name", "Map Test"]);
  git(["remote", "add", "origin", "https://GitHub.com/Acme/Research.git"]);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

async function writeDeepTree(): Promise<void> {
  const deep = join(root, "alpha", "bravo", "charlie", "delta", "echo");
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(
    join(root, "README.md"),
    "---\nname: Research\nsummary: Repository surface.\n---\n# Research\n",
  );
  await fs.writeFile(
    join(root, "alpha", "README.md"),
    "---\nname: Alpha\nsummary: Alpha branch.\n---\n# Alpha\n",
  );
  await fs.writeFile(
    join(deep, "finding.md"),
    "---\nname: Finding\nsummary: Deep finding.\n---\n# Finding\n",
  );
  await fs.mkdir(join(root, "_assets"), { recursive: true });
  await fs.writeFile(join(root, "_assets", "hidden.md"), "# Hidden\n");
}

describe("ideaspaces map", () => {
  it("returns a complete contract-free Map in the protocol rung vocabulary", async () => {
    await writeDeepTree();
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed"]);
    const head = git(["rev-parse", "HEAD"]);

    const result = await runMap(["."], { depth: "full" });

    expect(result.exit, result.stderr).toBe(0);
    expect(result.data).toMatchObject({
      kind: "derived-map",
      source: "local-working-tree",
      depth: "full",
      complete: true,
      portable: true,
      dirty: false,
      total_markdown_files: 3,
      omitted_entries: 0,
      map: {
        roots: [
          {
            local_path: root,
            space: "github.com/Acme/Research",
            sha: head,
          },
        ],
      },
    });
    expect(parseMap(result.data.map).status).toBe("valid");
    expect(result.data.map.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ space: 0, position: "alpha", depth: "children" }),
        expect.objectContaining({
          space: 0,
          position: "alpha/bravo/charlie/delta/echo/finding.md",
          depth: "summary",
          summary: "Deep finding.",
        }),
        expect.objectContaining({
          space: 0,
          position: "README.md",
          depth: "summary",
          summary: "Repository surface.",
        }),
      ]),
    );
    expect(
      result.data.map.members.every((member: { depth: string }) =>
        (MAP_DEPTHS as readonly string[]).includes(member.depth),
      ),
    ).toBe(true);
    expect(result.data.map.members.some((member: { position: string }) =>
      member.position.includes("_assets"),
    )).toBe(false);
  });

  it("keeps bounded depth bounded and labels ignored local Content non-portable", async () => {
    await writeDeepTree();
    await fs.writeFile(join(root, ".gitignore"), "new.md\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed"]);

    const bounded = await runMap(["."], { depth: "4" });
    expect(bounded.exit, bounded.stderr).toBe(0);
    expect(bounded.data.depth).toBe(4);
    expect(bounded.data.complete).toBe(false);
    expect(bounded.data.map.members.some((member: { position: string }) =>
      member.position.includes("echo"),
    )).toBe(false);

    await fs.writeFile(join(root, "new.md"), "# New working-tree Note\n");
    const dirty = await runMap(["."], { depth: "full" });
    expect(dirty.data).toMatchObject({
      dirty: true,
      portable: false,
      complete: true,
      local_only_paths: ["new.md"],
    });
    expect(dirty.data.map.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ position: "new.md", depth: "name" })]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "fails rather than calling unreadable territory complete",
    async () => {
      const locked = join(root, "locked");
      await fs.mkdir(locked);
      await fs.writeFile(join(locked, "hidden.md"), "# Hidden\n");
      git(["add", "."]);
      git(["commit", "-q", "-m", "seed"]);
      await fs.chmod(locked, 0o000);
      try {
        const result = await runMap(["."], { depth: "full" });
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain("Could not derive Map: Cannot count Content tree directory");
        expect(result.stdout).toBe("");
      } finally {
        await fs.chmod(locked, 0o700);
      }
    },
  );

  it("rejects invalid depth, non-roots, and non-repositories before walking", async () => {
    await fs.mkdir(join(root, "sub"));

    const invalidDepth = await runMap(["."], { depth: "5" });
    expect(invalidDepth.exit).toBe(1);
    expect(invalidDepth.stderr).toContain("Map depth must be 1, 2, 3, 4, or full");

    const nested = await runMap(["sub"], { depth: "full" });
    expect(nested.exit).toBe(1);
    expect(nested.stderr).toContain("Not a repository root");

    const outside = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-not-repo-")));
    try {
      const notRepo = await runMap([outside], { depth: "full" });
      expect(notRepo.exit).toBe(1);
      expect(notRepo.stderr).toContain("Not a Git repository");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
