import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parseDocument } from "yaml";
import { commitCommand } from "../commands/commit.js";
import { writeCommand } from "../commands/write.js";
import {
  localEffectCapabilities,
  localEffectGitRunner,
} from "../local-effects-adapter.js";
import { captureJson } from "./helpers.js";
import type { LocalEffectCapabilities } from "@ideaspaces/protocol";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  readFileSync(require.resolve("@ideaspaces/protocol/conformance/local-effects"), "utf8"),
) as {
  format: string;
  contents: Record<string, string>;
  required_coverage: string[];
  vectors: Array<Record<string, any>>;
};

let root: string;
let originalCwd: string;
let originalCapabilities: LocalEffectCapabilities;

function git(args: string[], check = true): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (check && result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return (result.stdout ?? "").trim();
}

async function seed(path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

function vector(id: string): Record<string, any> {
  const found = manifest.vectors.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing PF0 vector ${id}`);
  return found;
}

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-local-effects-")));
  originalCwd = process.cwd();
  process.chdir(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "--local", "user.name", "Person"]);
  git(["config", "--local", "user.email", "person@example.com"]);
  originalCapabilities = {
    git: localEffectCapabilities.git,
    filesystem: localEffectCapabilities.filesystem,
  };
});

afterEach(async () => {
  localEffectCapabilities.git = originalCapabilities.git;
  localEffectCapabilities.filesystem = originalCapabilities.filesystem;
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

describe("CLI adapter over PF0 local-effects fixtures", () => {
  it("loads the shipped language-neutral manifest, not a copied vector list", () => {
    expect(manifest.format).toBe("ideaspaces-local-effects/v1");
    expect(manifest.required_coverage).toEqual(
      expect.arrayContaining([
        "frontmatter_preserve_unknown",
        "revision_stale_worktree",
        "write_stage_partial",
        "bystanders_preserved",
        "explicit_identity_no_ambient",
      ]),
    );
  });

  it("adapts the PF0 Unicode create vector and returns protocol plus legacy facts", async () => {
    const fixture = vector("write-unicode-create");
    const { exit, json } = await captureJson(() =>
      writeCommand.run(
        [fixture.request.path],
        { content: fixture.request.body, name: fixture.request.frontmatter.set.name },
        G,
      ),
    );

    expect(exit).toBe(0);
    expect(json).toMatchObject({
      status: "ok",
      operation: "write_markdown",
      affected_paths: fixture.expected.result.affected_paths,
      staged: true,
    });
    expect(json.sha).toBe(json.path_revisions[0].revision.worktree);
    expect(await readFile(join(root, ...fixture.request.path.split("/")), "utf8")).toContain(
      "name: 日本語",
    );
  });

  it("preserves the PF0 unknown frontmatter structures by default", async () => {
    const fixture = vector("write-unicode-update-preserves-frontmatter");
    const path = fixture.request.path as string;
    await seed(path, manifest.contents["frontmatter-rich"]);
    git(["add", path]);
    git(["commit", "-q", "-m", "seed"]);

    const { exit } = await captureJson(() =>
      writeCommand.run([path], { content: fixture.request.body, name: "New", force: true, stage: "false" }, G),
    );
    expect(exit).toBe(0);
    const written = await readFile(join(root, ...path.split("/")), "utf8");
    const end = written.indexOf("\n---\n", 4);
    const parsed = parseDocument(written.slice(4, end)).toJS();
    expect(parsed).toMatchObject({
      name: "New",
      unknown_scalar: "keep",
      unknown_list: ["one", "two"],
      unknown_map: { nested: true },
    });
  });

  it("uses the PF0 path-refusal cases without touching the outside file", async () => {
    const fixture = vector("write-path-boundary-refusals");
    const outside = join(root, "..", "outside.md");
    await writeFile(outside, manifest.contents.outside, "utf8");
    try {
      for (const testCase of fixture.cases) {
        const input = testCase.path === "/outside.md" ? outside : testCase.path;
        const { exit, json } = await captureJson(() =>
          writeCommand.run([input], { content: fixture.request.body, force: true, stage: "false" }, G),
        );
        expect(exit, testCase.path).toBe(1);
        expect(json.code, testCase.path).toBe(testCase.code);
        expect(json.affected_paths, testCase.path).toEqual([]);
      }
      expect(await readFile(outside, "utf8")).toBe(manifest.contents.outside);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("refuses a target symlink from the PF0 fixture before writing", async () => {
    const fixture = vector("write-target-symlink-refusal");
    await seed("outside.md", manifest.contents.outside);
    await mkdir(join(root, "notes"), { recursive: true });
    await symlink("../outside.md", join(root, "notes/link.md"));

    const { exit, json } = await captureJson(() =>
      writeCommand.run([fixture.request.path], { content: "changed\n", force: true, stage: "false" }, G),
    );
    expect(exit).toBe(1);
    expect(json).toMatchObject({ status: "error", code: "symlink_refused", affected_paths: [] });
    expect(await readFile(join(root, "outside.md"), "utf8")).toBe(manifest.contents.outside);
  });

  it("refuses PF0 malformed frontmatter cases without changing their bytes", async () => {
    const fixture = vector("write-malformed-frontmatter-refusals");
    for (const [index, testCase] of fixture.cases.entries()) {
      const path = `malformed-${index}.md`;
      const original = manifest.contents[testCase.content];
      await seed(path, original);
      git(["add", path]);
      git(["commit", "-q", "-m", `seed ${index}`]);

      const { exit, json } = await captureJson(() =>
        writeCommand.run([path], { content: "# New\n", name: "Repaired", force: true, stage: "false" }, G),
      );
      expect(exit).toBe(1);
      expect(json).toMatchObject({
        status: "error",
        code: "malformed_frontmatter",
        phase: "preflight",
        affected_paths: [],
      });
      expect(await readFile(join(root, path), "utf8")).toBe(original);
    }
  });

  it("refuses an untracked ignored write but permits a later-ignored tracked path", async () => {
    const fixture = vector("write-ignored-new-refusal");
    await seed(".gitignore", "drafts/**\n*.local.md\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "ignore"]);

    const { exit, json } = await captureJson(() =>
      writeCommand.run(
        [fixture.request.path],
        { content: fixture.request.body, force: true, stage: "false" },
        G,
      ),
    );
    expect(exit).toBe(1);
    expect(json).toMatchObject({ status: "error", code: "ignored_local_path", affected_paths: [] });
    await expect(readFile(join(root, ...fixture.request.path.split("/")), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await seed("kept.local.md", "old\n");
    git(["add", "-f", "kept.local.md"]);
    git(["commit", "-q", "-m", "track ignored"]);
    const tracked = await captureJson(() =>
      writeCommand.run(["kept.local.md"], { content: "new\n", force: true, stage: "false" }, G),
    );
    expect(tracked.exit).toBe(0);
    expect(tracked.json.status).toBe("ok");
  });

  it("commits the PF0 literal path and preserves the glob-shaped bystander", async () => {
    const fixture = vector("commit-literal-pathspec");
    await seed("x.md", manifest.contents.v1);
    git(["add", "x.md"]);
    git(["commit", "-q", "-m", "seed"]);
    await seed("[x].md", manifest.contents.v2);

    const { exit, json } = await captureJson(() =>
      commitCommand.run([fixture.request.paths[0].path], { m: fixture.request.message, op: "create" }, G),
    );
    expect(exit).toBe(0);
    expect(json).toMatchObject({
      status: "ok",
      operation: "commit_paths",
      affected_paths: ["[x].md"],
      commit_sha: json.commit_oid,
    });
    expect(git(["show", "--name-only", "--format=", "HEAD"])).toBe("[x].md");
    expect(await readFile(join(root, "x.md"), "utf8")).toBe(manifest.contents.v1);
  });

  it("loses CAS when the worktree moves after CLI review but before the protocol boundary", async () => {
    await seed("raced.md", manifest.contents.v1);
    git(["add", "raced.md"]);
    git(["commit", "-q", "-m", "seed"]);
    const reviewedOid = git(["hash-object", "raced.md"]);
    let rootChecks = 0;
    localEffectCapabilities.git = async (repo, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && ++rootChecks === 2) {
        await writeFile(join(root, "raced.md"), manifest.contents.v2, "utf8");
      }
      return localEffectGitRunner(repo, args);
    };

    const { exit, json } = await captureJson(() =>
      writeCommand.run(
        ["raced.md"],
        { content: "replacement\n", "if-match": reviewedOid, stage: "false" },
        G,
      ),
    );
    expect(exit).toBe(6);
    expect(json).toMatchObject({ status: "error", code: "revision_mismatch", phase: "revision_check" });
    expect(await readFile(join(root, "raced.md"), "utf8")).toBe(manifest.contents.v2);
  });

  it("returns a typed partial when write succeeds but PF0 staging fails", async () => {
    localEffectCapabilities.git = async (repo, args) =>
      args[0] === "add"
        ? { ok: false, stdout: "", stderr: "injected stage failure", code: 1 }
        : localEffectGitRunner(repo, args);

    const { exit, json } = await captureJson(() =>
      writeCommand.run(["partial.md"], { content: "# Partial\n" }, G),
    );
    expect(exit).toBe(1);
    expect(json).toMatchObject({
      status: "partial",
      code: "stage_failed",
      phase: "stage",
      completed_phases: ["revision_check", "write"],
    });
    expect(await readFile(join(root, "partial.md"), "utf8")).toContain("# Partial");
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
  });

  it("returns a typed error when the atomic replacement fails", async () => {
    localEffectCapabilities.filesystem = {
      ...localEffectCapabilities.filesystem,
      async atomicWriteUtf8() {
        throw new Error("injected atomic write failure");
      },
    };

    const { exit, json } = await captureJson(() =>
      writeCommand.run(["failed.md"], { content: "# Failed\n", stage: "false" }, G),
    );
    expect(exit).toBe(1);
    expect(json).toMatchObject({ status: "error", code: "atomic_write_failed", phase: "write" });
    await expect(readFile(join(root, "failed.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a typed commit partial and leaves bystander index state untouched", async () => {
    await seed("selected.md", "selected\n");
    await seed("bystander.txt", "bystander\n");
    git(["add", "bystander.txt"]);
    localEffectCapabilities.git = async (repo, args) =>
      args.includes("commit")
        ? { ok: false, stdout: "", stderr: "injected commit failure", code: 1 }
        : localEffectGitRunner(repo, args);

    const { exit, json } = await captureJson(() =>
      commitCommand.run(["selected.md"], { m: "selected only" }, G),
    );
    expect(exit).toBe(1);
    expect(json).toMatchObject({
      status: "partial",
      code: "commit_failed",
      phase: "commit",
      completed_phases: ["revision_check", "stage"],
    });
    expect(git(["diff", "--cached", "--name-only"]).split("\n").sort()).toEqual([
      "bystander.txt",
      "selected.md",
    ]);
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });
});
