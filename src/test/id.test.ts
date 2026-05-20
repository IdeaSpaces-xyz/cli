import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { idCommand } from "../commands/id.js";
import type { GlobalFlags } from "../types.js";

const baseGlobal: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};

let tmp: string;
let originalCwd: string;

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-id-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

function nodeIdOf(path: string): string | null {
  const content = readFileSync(join(tmp, path), "utf-8");
  const match = content.match(/^node_id:\s*(n_[0-9a-f]+)/m);
  return match?.[1] ?? null;
}

describe("ideaspaces id", () => {
  it("prints a deprecation warning", async () => {
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stderr.write;

    try {
      const exit = await idCommand.run(["."], {}, { ...baseGlobal, json: false, quiet: false });
      expect(exit).toBe(0);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(stderr).toContain("`ideaspaces id` is deprecated");
  });

  it("reports missing node_id", async () => {
    await fs.writeFile(join(tmp, "missing.md"), "---\nname: Missing\n---\n# Missing\n", "utf-8");

    const exit = await idCommand.run(["missing.md"], {}, baseGlobal);

    expect(exit).toBe(1);
  });

  it("errors when the target path does not exist", async () => {
    const exit = await idCommand.run(["nope.md"], {}, baseGlobal);

    expect(exit).toBe(1);
  });

  it("injects missing 96-bit node_id with --fix", async () => {
    await fs.writeFile(join(tmp, "missing.md"), "---\nname: Missing\n---\n# Missing\n", "utf-8");

    const exit = await idCommand.run(["missing.md"], { fix: true }, baseGlobal);

    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "missing.md"), "utf-8");
    expect(written).toMatch(/^name: Missing\nnode_id: n_[0-9a-f]{24}$/m);
  });

  it("preserves valid legacy node_id", async () => {
    await fs.writeFile(join(tmp, "legacy.md"), "---\nnode_id: n_abcdef123456\n---\n# Legacy\n", "utf-8");

    const exit = await idCommand.run(["legacy.md"], { fix: true }, baseGlobal);

    expect(exit).toBe(0);
    expect(nodeIdOf("legacy.md")).toBe("n_abcdef123456");
  });

  it("preserves valid 96-bit node_id", async () => {
    const id = "n_abcdef123456abcdef123456";
    await fs.writeFile(join(tmp, "new.md"), `---\nnode_id: ${id}\n---\n# New\n`, "utf-8");

    const exit = await idCommand.run(["new.md"], { fix: true }, baseGlobal);

    expect(exit).toBe(0);
    expect(nodeIdOf("new.md")).toBe(id);
  });

  it("does not auto-fix malformed node_id", async () => {
    await fs.writeFile(join(tmp, "bad.md"), "---\nnode_id: nope\n---\n# Bad\n", "utf-8");

    const exit = await idCommand.run(["bad.md"], { fix: true }, baseGlobal);

    expect(exit).toBe(1);
    expect((await fs.readFile(join(tmp, "bad.md"), "utf-8"))).toContain("node_id: nope");
  });

  it("does not inject node_id into malformed frontmatter", async () => {
    const original = "---\nname: `ideaspace create` — Adopt and Publish\n---\n# Bad\n";
    await fs.writeFile(join(tmp, "bad-frontmatter.md"), original, "utf-8");

    const exit = await idCommand.run(["bad-frontmatter.md"], { fix: true }, baseGlobal);

    expect(exit).toBe(1);
    expect(await fs.readFile(join(tmp, "bad-frontmatter.md"), "utf-8")).toBe(original);
  });

  it("does not auto-fix duplicates", async () => {
    const content = "---\nnode_id: n_abcdef123456abcdef123456\n---\n# Dup\n";
    await fs.writeFile(join(tmp, "a.md"), content, "utf-8");
    await fs.writeFile(join(tmp, "b.md"), content, "utf-8");

    const exit = await idCommand.run(["."], { fix: true }, baseGlobal);

    expect(exit).toBe(1);
    expect(nodeIdOf("a.md")).toBe("n_abcdef123456abcdef123456");
    expect(nodeIdOf("b.md")).toBe("n_abcdef123456abcdef123456");
  });

  it("regenerates a selected file", async () => {
    const oldId = "n_abcdef123456abcdef123456";
    await fs.writeFile(join(tmp, "copy.md"), `---\nnode_id: ${oldId}\n---\n# Copy\n`, "utf-8");

    const exit = await idCommand.run([], { regenerate: "copy.md" }, baseGlobal);

    expect(exit).toBe(0);
    const next = nodeIdOf("copy.md");
    expect(next).toMatch(/^n_[0-9a-f]{24}$/);
    expect(next).not.toBe(oldId);
  });

  it("does not regenerate node_id in malformed frontmatter", async () => {
    const original = "---\nname: `ideaspace create` — Adopt and Publish\nnode_id: n_abcdef123456abcdef123456\n---\n# Bad\n";
    await fs.writeFile(join(tmp, "bad-frontmatter.md"), original, "utf-8");

    const exit = await idCommand.run([], { regenerate: "bad-frontmatter.md" }, baseGlobal);

    expect(exit).toBe(1);
    expect(await fs.readFile(join(tmp, "bad-frontmatter.md"), "utf-8")).toBe(original);
  });

  it("errors when --regenerate has no path value", async () => {
    const exit = await idCommand.run(["copy.md"], { regenerate: true }, baseGlobal);

    expect(exit).toBe(1);
  });

  it("fixes only staged markdown and re-stages changes", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    await fs.writeFile(join(tmp, "staged.md"), "# Staged\n", "utf-8");
    await fs.writeFile(join(tmp, "unstaged.md"), "# Unstaged\n", "utf-8");
    spawnSync("git", ["add", "staged.md"]);

    const exit = await idCommand.run([], { fix: true, staged: true }, baseGlobal);

    expect(exit).toBe(0);
    expect(nodeIdOf("staged.md")).toMatch(/^n_[0-9a-f]{24}$/);
    expect(nodeIdOf("unstaged.md")).toBe(null);
    const cached = spawnSync("git", ["diff", "--cached", "--", "staged.md"], {
      encoding: "utf-8",
    }).stdout;
    expect(cached).toContain("node_id: n_");
  });

  it("resolves staged git paths from repo root when run in a subdirectory", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    await fs.mkdir(join(tmp, "sub"));
    await fs.writeFile(join(tmp, "root.md"), "# Root\n", "utf-8");
    spawnSync("git", ["add", "root.md"]);

    const previous = process.cwd();
    process.chdir(join(tmp, "sub"));
    try {
      const exit = await idCommand.run([], { fix: true, staged: true }, baseGlobal);
      expect(exit).toBe(0);
    } finally {
      process.chdir(previous);
    }

    expect(nodeIdOf("root.md")).toMatch(/^n_[0-9a-f]{24}$/);
  });

  it("regenerates and re-stages a staged file", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    const oldId = "n_abcdef123456abcdef123456";
    await fs.writeFile(join(tmp, "copy.md"), `---\nnode_id: ${oldId}\n---\n# Copy\n`, "utf-8");
    spawnSync("git", ["add", "copy.md"]);
    spawnSync("git", ["commit", "-q", "-m", "add copy"]);
    await fs.writeFile(join(tmp, "copy.md"), `---\nnode_id: ${oldId}\n---\n# Copy updated\n`, "utf-8");
    spawnSync("git", ["add", "copy.md"]);

    const exit = await idCommand.run([], { regenerate: "copy.md", staged: true }, baseGlobal);

    expect(exit).toBe(0);
    const next = nodeIdOf("copy.md");
    expect(next).toMatch(/^n_[0-9a-f]{24}$/);
    expect(next).not.toBe(oldId);
    const cached = spawnSync("git", ["diff", "--cached", "--", "copy.md"], {
      encoding: "utf-8",
    }).stdout;
    expect(cached).toContain(`-node_id: ${oldId}`);
    expect(cached).toContain("+node_id: n_");
  });

  it("refuses staged fix for partially-staged markdown files", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    await fs.writeFile(join(tmp, "partial.md"), "# One\n", "utf-8");
    spawnSync("git", ["add", "partial.md"]);
    await fs.writeFile(join(tmp, "partial.md"), "# One\n\nUnstaged edit\n", "utf-8");

    const exit = await idCommand.run([], { fix: true, staged: true }, baseGlobal);

    expect(exit).toBe(1);
    expect(nodeIdOf("partial.md")).toBe(null);
  });

  it("refuses staged regenerate for partially-staged markdown files", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    await fs.writeFile(join(tmp, "partial.md"), "---\nnode_id: n_abcdef123456\n---\n# One\n", "utf-8");
    spawnSync("git", ["add", "partial.md"]);
    await fs.writeFile(join(tmp, "partial.md"), "---\nnode_id: n_abcdef123456\n---\n# One\n\nUnstaged edit\n", "utf-8");

    const exit = await idCommand.run([], { regenerate: "partial.md", staged: true }, baseGlobal);

    expect(exit).toBe(1);
    expect(nodeIdOf("partial.md")).toBe("n_abcdef123456");
  });

  it("installs a repo-local pre-commit hook", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);

    const exit = await idCommand.run(["install-hook"], {}, baseGlobal);

    expect(exit).toBe(0);
    const hook = join(tmp, ".git", "hooks", "pre-commit");
    expect(existsSync(hook)).toBe(true);
    const hookContent = await fs.readFile(hook, "utf-8");
    expect(hookContent).toMatch(/node .+id --fix --staged/);
  });

  it("does not overwrite an already installed hook", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    const hook = join(tmp, ".git", "hooks", "pre-commit");
    expect(await idCommand.run(["install-hook"], {}, baseGlobal)).toBe(0);
    await fs.appendFile(hook, "echo custom\n", "utf-8");

    const exit = await idCommand.run(["install-hook"], {}, baseGlobal);

    expect(exit).toBe(0);
    expect(await fs.readFile(hook, "utf-8")).toContain("echo custom");
  });

  it("refuses to overwrite a foreign pre-commit hook", async () => {
    spawnSync("git", ["init", "-q", "-b", "main"]);
    mkdirSync(join(tmp, ".git", "hooks"), { recursive: true });
    writeFileSync(join(tmp, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho custom\n");

    const exit = await idCommand.run(["install-hook"], {}, baseGlobal);

    expect(exit).toBe(1);
    expect(await fs.readFile(join(tmp, ".git", "hooks", "pre-commit"), "utf-8")).toContain("custom");
  });
});
