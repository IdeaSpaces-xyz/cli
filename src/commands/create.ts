/**
 * `ideaspaces create [name]` — scaffold an ideaspace.
 *
 * Without name → operates on cwd (existing-content path).
 * With name → creates `./<name>/` (greenfield path).
 *
 * Auto-detects the target shape (greenfield, content-existing, code-repo,
 * old-shape, complete) and applies the right scaffold. Never overwrites
 * user content or existing CLAUDE.md / .gitignore — appends only.
 *
 * Scaffolds the seed of the contract: foundation.md + guide.md + CLAUDE.md
 * + .gitignore + .gitattributes. purpose.md / now.md / next.md are emergent
 * — the agent on first session reads foundation+guide, sees those names
 * without matching files, and proposes capturing them in conversation.
 *
 * Without `--yes`, prints the plan and exits 0 without applying. With
 * `--yes`, applies. Errors don't roll back partial scaffolds — git is the
 * recovery surface.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, basename } from "node:path";
import { createOutput } from "../output.js";
import { loadStoredCredentials } from "../auth/credentials.js";
import type { CommandDef } from "../types.js";
import {
  CLAUDE_MD,
  CONTRACT_TEMPLATES,
  GITATTRIBUTES,
  gitignoreDefaults,
} from "../templates/default.js";
import { ensureMarkdownNodeId } from "@ideaspaces/sdk";

type Shape = "greenfield" | "content-existing" | "code-repo" | "old-shape" | "complete";

interface Inspection {
  exists: boolean;
  isGitRepo: boolean;
  hasNewAgent: boolean;
  hasOldAgent: boolean;
  hasClaude: boolean;
  hasGitignore: boolean;
  hasCodeSignal: boolean;
  markdownCount: number;
}

const CODE_SIGNALS = [
  ".github",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "pom.xml",
];

const OLD_AGENT_FILES = ["always.md", "rules.md", "soul.md", "guidance.md"];

export const createCommand: CommandDef = {
  name: "create",
  description: "Scaffold an ideaspace (seed _agent/ contract + CLAUDE.md + .gitignore defaults)",
  usage: "ideaspaces create [name] [--yes] [--shared]",
  examples: [
    "ideaspaces create my-space             # plan in ./my-space/, exit without applying",
    "ideaspaces create my-space --yes       # scaffold and commit",
    "ideaspaces create --yes                # scaffold in current directory",
    "ideaspaces create --yes --shared       # in a code repo, opt into shared (committed) _agent/",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const name = args[0];
    const targetDir = name ? resolve(process.cwd(), name) : process.cwd();
    const apply = global.yes === true;
    const sharedFlag = Boolean(flags.shared);

    const inspection = await inspect(targetDir);
    const shape = detectShape(inspection);

    if (shape === "complete") {
      output.error(
        `${describeTarget(targetDir, name)} is already an ideaspace. Edit \`_agent/\` directly or use \`/is-reflect\` to update direction.`,
      );
      return 5;
    }
    if (shape === "old-shape") {
      output.error(
        `${describeTarget(targetDir, name)} has an \`_agent/\` in the legacy shape (always.md / rules.md / soul.md). Migration is not yet automated; see \`ideaspace/architecture/plans/plugin-local-first/ideaspace-create.md\` for the manual walk.`,
      );
      return 5;
    }

    const privateAgent = shape === "code-repo" && !sharedFlag;
    const plan = buildPlan({ targetDir, name, shape, inspection, privateAgent });

    if (!apply) {
      output.result(
        { target: targetDir, shape, privateAgent, plan: plan.steps },
        renderPlanText({ targetDir, name, shape, privateAgent, plan }),
      );
      return 0;
    }

    try {
      await applyPlan({ targetDir, inspection, privateAgent });
    } catch (err) {
      output.error(
        `Scaffold failed midway: ${err instanceof Error ? err.message : String(err)}\nUse \`git status\` / \`git restore\` to recover.`,
      );
      return 1;
    }

    const where = name ? `./${name}` : "this directory";
    const lines = [
      `Scaffolded ${describeTarget(targetDir, name)} (${shape}${privateAgent ? ", private _agent/" : ""}).`,
      `Next: open Claude Code in ${where} — the agent will read foundation+guide and propose capturing purpose / now / next in conversation.`,
    ];
    if (loadStoredCredentials()) {
      lines.push(`When ready to host this remotely, run \`ideaspaces publish\` from inside ${where}.`);
    }
    output.result(
      { target: targetDir, shape, privateAgent, scaffolded: true },
      lines.join("\n"),
    );
    return 0;
  },
};

async function inspect(targetDir: string): Promise<Inspection> {
  if (!existsSync(targetDir)) {
    return {
      exists: false,
      isGitRepo: false,
      hasNewAgent: false,
      hasOldAgent: false,
      hasClaude: false,
      hasGitignore: false,
      hasCodeSignal: false,
      markdownCount: 0,
    };
  }
  const isGitRepo = existsSync(join(targetDir, ".git"));
  const hasClaude = existsSync(join(targetDir, "CLAUDE.md"));
  const hasGitignore = existsSync(join(targetDir, ".gitignore"));
  const agentDir = join(targetDir, "_agent");
  const hasNewAgent = existsSync(join(agentDir, "foundation.md"));
  const hasOldAgent =
    existsSync(agentDir) &&
    OLD_AGENT_FILES.some((f) => existsSync(join(agentDir, f))) &&
    !hasNewAgent;

  let hasCodeSignal = false;
  for (const sig of CODE_SIGNALS) {
    if (existsSync(join(targetDir, sig))) {
      hasCodeSignal = true;
      break;
    }
  }

  let markdownCount = 0;
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) markdownCount += 1;
    }
  } catch {
    // ignore
  }

  return {
    exists: true,
    isGitRepo,
    hasNewAgent,
    hasOldAgent,
    hasClaude,
    hasGitignore,
    hasCodeSignal,
    markdownCount,
  };
}

function detectShape(inspection: Inspection): Shape {
  if (!inspection.exists) return "greenfield";
  if (inspection.hasNewAgent && inspection.hasClaude) return "complete";
  if (inspection.hasOldAgent) return "old-shape";
  if (inspection.hasCodeSignal) return "code-repo";
  if (inspection.markdownCount > 0) return "content-existing";
  return "greenfield";
}

interface PlanStep {
  op: "mkdir" | "git-init" | "write" | "append" | "commit";
  path?: string;
  detail?: string;
}

interface Plan {
  steps: PlanStep[];
}

function buildPlan(opts: {
  targetDir: string;
  name?: string;
  shape: Shape;
  inspection: Inspection;
  privateAgent: boolean;
}): Plan {
  const { targetDir, name, inspection, privateAgent } = opts;
  const steps: PlanStep[] = [];

  if (name && !inspection.exists) {
    steps.push({ op: "mkdir", path: targetDir });
  }
  if (!inspection.isGitRepo) {
    steps.push({ op: "git-init", path: targetDir });
  }

  for (const fileName of Object.keys(CONTRACT_TEMPLATES)) {
    steps.push({ op: "write", path: join(targetDir, "_agent", `${fileName}.md`) });
  }

  const claudeFile = privateAgent ? "CLAUDE.local.md" : "CLAUDE.md";
  if (!inspection.hasClaude) {
    steps.push({ op: "write", path: join(targetDir, claudeFile) });
  }

  if (!existsSync(join(targetDir, ".gitattributes"))) {
    steps.push({
      op: "write",
      path: join(targetDir, ".gitattributes"),
      detail: "markdown diff/eol attributes",
    });
  }

  steps.push({
    op: inspection.hasGitignore ? "append" : "write",
    path: join(targetDir, ".gitignore"),
    detail: privateAgent ? "private _agent/ defaults" : "content-space defaults",
  });

  steps.push({ op: "commit", detail: "Initial ideaspace scaffold" });

  return { steps };
}

function renderPlanText(opts: {
  targetDir: string;
  name?: string;
  shape: Shape;
  privateAgent: boolean;
  plan: Plan;
}): string {
  const { targetDir, name, shape, privateAgent, plan } = opts;
  const lines: string[] = [];
  lines.push(`Plan for ${describeTarget(targetDir, name)} — shape: ${shape}${privateAgent ? " (private _agent/)" : ""}`);
  lines.push("");
  for (const step of plan.steps) {
    const tag = step.op.toUpperCase().padEnd(9);
    const detail = step.detail ? ` — ${step.detail}` : "";
    const path = step.path ? ` ${step.path}` : "";
    lines.push(`  ${tag}${path}${detail}`);
  }
  lines.push("");
  lines.push("Re-run with --yes to apply.");
  return lines.join("\n");
}

async function applyPlan(opts: {
  targetDir: string;
  inspection: Inspection;
  privateAgent: boolean;
}): Promise<void> {
  const { targetDir, inspection, privateAgent } = opts;

  await fs.mkdir(targetDir, { recursive: true });

  if (!inspection.isGitRepo) {
    runGit(targetDir, ["init", "-q", "-b", "main"]);
  }

  await fs.mkdir(join(targetDir, "_agent"), { recursive: true });
  for (const [name, content] of Object.entries(CONTRACT_TEMPLATES)) {
    await fs.writeFile(join(targetDir, "_agent", `${name}.md`), withNodeId(content), "utf-8");
  }

  const claudeFile = privateAgent ? "CLAUDE.local.md" : "CLAUDE.md";
  if (!inspection.hasClaude) {
    // Orientation files are publishable markdown objects too; stamp identity at creation.
    await fs.writeFile(join(targetDir, claudeFile), withNodeId(CLAUDE_MD), "utf-8");
  }

  const gitattributesPath = join(targetDir, ".gitattributes");
  if (!existsSync(gitattributesPath)) {
    await fs.writeFile(gitattributesPath, GITATTRIBUTES, "utf-8");
  }

  const gitignorePath = join(targetDir, ".gitignore");
  const additions = gitignoreDefaults({ privateAgent });
  if (inspection.hasGitignore) {
    const existing = await fs.readFile(gitignorePath, "utf-8");
    if (!existing.includes("# ideaspace defaults")) {
      await fs.writeFile(
        gitignorePath,
        existing.endsWith("\n") ? existing + additions : existing + "\n" + additions,
        "utf-8",
      );
    }
  } else {
    await fs.writeFile(gitignorePath, additions.replace(/^\n/, ""), "utf-8");
  }

  // Stage and commit. If user has no git identity configured, the commit will
  // fail; the caller surfaces that error.
  runGit(targetDir, ["add", "."]);
  runGit(targetDir, ["commit", "-q", "-m", "Initial ideaspace scaffold"]);
}

function withNodeId(content: string): string {
  return ensureMarkdownNodeId(content).content;
}

function runGit(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) {
    const message = r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`;
    throw new Error(`git ${args.join(" ")}: ${message}`);
  }
}

function describeTarget(targetDir: string, name?: string): string {
  return name ? `./${basename(targetDir)}` : "the current directory";
}
