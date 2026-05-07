import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import {
  collectMarkdownFiles,
  ensureMarkdownNodeId,
  inspectMarkdownIdentity,
  isMarkdownPath,
} from "@ideaspaces/sdk";

interface FileStatus {
  path: string;
  status: "valid" | "missing" | "malformed";
  node_id: string | null;
  duplicate: boolean;
  message?: string;
}

interface ScanResult {
  files: FileStatus[];
  missing: FileStatus[];
  malformed: FileStatus[];
  duplicates: FileStatus[];
}

const HOOK_MARKER = "# ideaspaces-node-id-hook";

export const idCommand: CommandDef = {
  name: "id",
  description: "Check and repair local markdown node_id frontmatter",
  usage:
    "ideaspaces id [path] [--fix] [--staged] | ideaspaces id --regenerate <path> | ideaspaces id install-hook",
  examples: [
    "ideaspaces id .                         # check all markdown files",
    "ideaspaces id notes/acme.md             # check one file",
    "ideaspaces id --fix .                   # inject missing node_id fields",
    "ideaspaces id --fix --staged            # pre-commit mode: fix staged markdown files and re-stage",
    "ideaspaces id --regenerate copy.md      # replace one file's node_id",
    "ideaspaces id install-hook              # install repo-local pre-commit hook",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    if (args[0] === "install-hook") {
      return installHook(output);
    }

    if (flags.regenerate === true) {
      output.error("Usage: ideaspaces id --regenerate <path>");
      return 1;
    }
    const regeneratePath = typeof flags.regenerate === "string" ? flags.regenerate : undefined;
    if (regeneratePath) {
      return regenerateFile(regeneratePath, output, Boolean(flags.staged));
    }

    const staged = Boolean(flags.staged);
    const fix = Boolean(flags.fix);
    const target = args[0] ?? ".";

    if (!staged && !existsSync(resolve(target))) {
      output.error(`Path not found: ${target}`);
      return 1;
    }

    let files: string[];
    if (staged) {
      try {
        files = stagedMarkdownFiles();
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    } else {
      files = await collectMarkdownFiles(target);
    }

    if (!files.length) {
      output.result({ files: 0, ok: true }, "No markdown files found.");
      return 0;
    }

    const scan = await scanFiles(files);

    if (fix) {
      if (scan.malformed.length || scan.duplicates.length) {
        output.error(renderProblems(scan));
        output.error("Run `ideaspaces id --regenerate <path>` to intentionally reset a malformed or duplicate identity.");
        return 1;
      }

      let fixed = 0;
      for (const file of scan.missing) {
        const content = await readFile(file.path, "utf-8");
        const result = ensureMarkdownNodeId(content);
        if (result.changed) {
          await writeFile(file.path, result.content, "utf-8");
          fixed += 1;
        }
      }
      if (staged && fixed > 0) {
        try {
          gitAdd(scan.missing.map((f) => f.path));
        } catch (err) {
          output.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      output.result(
        { files: scan.files.length, fixed, ok: true },
        fixed === 0 ? `OK: ${scan.files.length} markdown files already have node_id.` : `Fixed ${fixed} markdown files.`,
      );
      return 0;
    }

    if (scan.missing.length || scan.malformed.length || scan.duplicates.length) {
      output.error(renderProblems(scan));
      return 1;
    }

    output.result(
      { files: scan.files.length, ok: true },
      `OK: ${scan.files.length} markdown files have valid node_id fields.`,
    );
    return 0;
  },
};

async function scanFiles(files: string[]): Promise<ScanResult> {
  const statuses: FileStatus[] = [];
  const byId = new Map<string, FileStatus[]>();

  for (const path of files) {
    const content = await readFile(path, "utf-8");
    const identity = inspectMarkdownIdentity(content);
    const status: FileStatus = {
      path,
      status: identity.status,
      node_id: identity.node_id,
      duplicate: false,
      message: identity.message,
    };
    statuses.push(status);
    if (identity.status === "valid" && identity.node_id) {
      const group = byId.get(identity.node_id) ?? [];
      group.push(status);
      byId.set(identity.node_id, group);
    }
  }

  const duplicates: FileStatus[] = [];
  for (const group of byId.values()) {
    if (group.length <= 1) continue;
    for (const item of group) {
      item.duplicate = true;
      duplicates.push(item);
    }
  }

  return {
    files: statuses,
    missing: statuses.filter((s) => s.status === "missing"),
    malformed: statuses.filter((s) => s.status === "malformed"),
    duplicates,
  };
}

async function regenerateFile(path: string, output: ReturnType<typeof createOutput>, staged: boolean): Promise<number> {
  const abs = resolve(path);
  if (!existsSync(abs) || !isMarkdownPath(abs)) {
    output.error(`Not a markdown file: ${path}`);
    return 1;
  }
  const s = await stat(abs);
  if (!s.isFile()) {
    output.error(`Not a file: ${path}`);
    return 1;
  }

  if (staged) {
    try {
      assertNoUnstagedMarkdown([abs]);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const content = await readFile(abs, "utf-8");
  const result = ensureMarkdownNodeId(content, { regenerate: true });
  await writeFile(abs, result.content, "utf-8");
  if (staged) {
    try {
      gitAdd([abs]);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  output.result(
    { path: abs, node_id: result.node_id, old_node_id: result.old_node_id, regenerated: true },
    result.old_node_id
      ? `Regenerated ${relative(process.cwd(), abs) || abs}: ${result.old_node_id} → ${result.node_id}`
      : `Added ${relative(process.cwd(), abs) || abs}: ${result.node_id}`,
  );
  return 0;
}

function stagedMarkdownFiles(): string[] {
  const repoRoot = gitRepoRoot();
  const staged = gitNameList(repoRoot, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--", "*.md"]);
  assertNoUnstagedMarkdown(staged);
  return staged;
}

function assertNoUnstagedMarkdown(paths: string[]): void {
  const repoRoot = gitRepoRoot();
  const unstaged = new Set(gitNameList(repoRoot, ["diff", "--name-only", "-z", "--", "*.md"]));
  const overlap = paths.filter((p) => unstaged.has(p));
  if (overlap.length > 0) {
    throw new Error(
      "staged identity fix refuses partially-staged markdown files:\n" +
        overlap.map((p) => `  ${relative(process.cwd(), p) || p}`).join("\n") +
        "\nStage or stash those changes, then retry.",
    );
  }
}

function gitRepoRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(r.stderr.trim() || "git rev-parse --show-toplevel failed");
  }
  return r.stdout.trim();
}

function gitNameList(repoRoot: string, args: string[]): string[] {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(r.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((p) => join(repoRoot, p));
}

function gitAdd(paths: string[]): void {
  if (!paths.length) return;
  const r = spawnSync("git", ["add", "--", ...paths], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(r.stderr.trim() || "git add failed");
  }
}

async function installHook(output: ReturnType<typeof createOutput>): Promise<number> {
  const gitDir = findGitDir();
  if (!gitDir) {
    output.error("Not a git repo. Run this from inside the repo where you want the hook installed.");
    return 1;
  }

  const hookPath = join(gitDir, "hooks", "pre-commit");
  const hook = [
    "#!/bin/sh",
    HOOK_MARKER,
    "set -e",
    "ideaspaces id --fix --staged",
    "",
  ].join("\n");

  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      output.result({ installed: true, path: hookPath, already_installed: true }, `Pre-commit hook already installed: ${hookPath}`);
      return 0;
    }
    output.error(
      `pre-commit hook already exists: ${hookPath}\n` +
        "Refusing to overwrite it. Move it aside or merge `ideaspaces id --fix --staged` manually.",
    );
    return 1;
  }

  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, hook, "utf-8");
  await chmod(hookPath, 0o755);
  output.result({ installed: true, path: hookPath }, `Installed pre-commit hook: ${hookPath}`);
  return 0;
}

function findGitDir(): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const gitDir = r.stdout.trim();
  if (!gitDir) return null;
  return resolve(gitDir);
}

function renderProblems(scan: ScanResult): string {
  const lines: string[] = [];
  if (scan.missing.length) {
    lines.push(`Missing node_id (${scan.missing.length}):`);
    for (const item of scan.missing) lines.push(`  ${displayPath(item.path)}`);
  }
  if (scan.malformed.length) {
    if (lines.length) lines.push("");
    lines.push(`Malformed node_id (${scan.malformed.length}):`);
    for (const item of scan.malformed) {
      const suffix = item.message ? ` — ${item.message}` : "";
      lines.push(`  ${displayPath(item.path)}${suffix}`);
    }
  }
  if (scan.duplicates.length) {
    if (lines.length) lines.push("");
    lines.push(`Duplicate node_id (${scan.duplicates.length} files):`);
    const byId = new Map<string, FileStatus[]>();
    for (const item of scan.duplicates) {
      if (!item.node_id) continue;
      const group = byId.get(item.node_id) ?? [];
      group.push(item);
      byId.set(item.node_id, group);
    }
    for (const [id, group] of byId) {
      lines.push(`  ${id}`);
      for (const item of group) lines.push(`    ${displayPath(item.path)}`);
    }
  }
  return lines.join("\n");
}

function displayPath(path: string): string {
  return relative(process.cwd(), path) || path;
}
