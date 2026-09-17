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
 * Scaffolds one contract file, `_agent/agreement.md`, under the knowledge
 * kind (default) or the agent kind (`--agent`), referencing that kind's public
 * Agreement Space; plus a short CLAUDE.md, .gitignore defaults, and
 * .gitattributes. The Agreement's sections are prompts the agent replaces in
 * conversation — create is the safe scaffold writer, not the conversation.
 * Shared scaffolds mint portable root identity into the Agreement before
 * login; a code repo's private gitignored contract remains unstamped.
 * `--foundation` writes the older foundation.md + guide.md shape for one more
 * release.
 *
 * Without `--yes`, prints the plan and exits 0 without applying. With
 * `--yes`, applies. Files are materialized first; git (init + initial commit)
 * is a best-effort finalize — a missing git binary or unconfigured identity
 * leaves a usable, unversioned local space rather than a partial abort.
 * The initial commit is scoped to the paths the scaffold wrote — anything
 * the user already had staged in an existing repo is left untouched.
 */

import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, relative, basename, sep } from "node:path";
import { createOutput } from "../output.js";
import { loadStoredCredentials } from "../auth/credentials.js";
import { fetchAuthMe } from "../auth/api.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { gitAvailability } from "../git.js";
import { mintDeclaredRootIdentity } from "../root-identity.js";
import type { CommandDef } from "../types.js";
import {
  agentClaudeMd,
  agentContractTemplates,
  agreementClaudeMd,
  agreementContractTemplates,
  isSafeAgentName,
  CLAUDE_MD,
  CONTRACT_TEMPLATES,
  GITATTRIBUTES,
  KIND_REFERENCES,
  PERSPECTIVES_README_MD,
  SKILLS_README_MD,
  gitignoreWithDefaults,
  type Kind,
} from "../templates/default.js";

/** Convention READMEs — written only by the Foundation scaffold. */
const CONVENTION_READMES: Record<string, string> = {
  skills: SKILLS_README_MD,
  perspectives: PERSPECTIVES_README_MD,
};

type ContractShape = "agreement" | "foundation";

type Shape = "greenfield" | "content-existing" | "code-repo" | "old-shape" | "complete";

interface Inspection {
  exists: boolean;
  isGitRepo: boolean;
  /**
   * Root of an enclosing git repo when the target will become a NEW nested
   * repo inside it — i.e. the target isn't itself that repo's root. Null
   * otherwise. Drives the "you're nesting a repo" notice; create still inits
   * an independent repo (the safe default), but says so instead of silently.
   */
  nestedInRepo: string | null;
  hasFoundation: boolean;
  hasAgreement: boolean;
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
  description: "Scaffold an ideaspace (_agent/agreement.md + CLAUDE.md + .gitignore defaults)",
  usage: "ideaspaces create [name] [--yes] [--shared] [--agent] [--foundation]",
  examples: [
    "ideaspaces create my-space             # plan in ./my-space/, exit without applying",
    "ideaspaces create my-space --yes       # scaffold and commit",
    "ideaspaces create --yes                # scaffold in current directory",
    "ideaspaces create --yes --shared       # in a code repo, opt into shared (committed) _agent/",
    "ideaspaces create scribe --yes --agent # an agent: the folder IS the agent",
    "ideaspaces create --yes --foundation   # the older foundation.md + guide.md shape (one more release)",
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
        `${describeTarget(targetDir, name)} is already an ideaspace. Edit \`_agent/\` directly, or ask your agent to reflect on direction.`,
      );
      return 5;
    }
    if (shape === "old-shape") {
      output.error(
        `${describeTarget(targetDir, name)} has an \`_agent/\` in the legacy shape (always.md / rules.md / soul.md). Migration is not yet automated; move their content into \`_agent/agreement.md\` by hand.`,
      );
      return 5;
    }

    const agentMode = Boolean(flags.agent);
    if (agentMode && shape === "code-repo") {
      output.error(
        `${describeTarget(targetDir, name)} looks like a code repo. An agent is its own space — the tree is the agent's memory, not a codebase. Create it in a fresh folder: \`ideaspaces create <name> --agent\`.`,
      );
      return 5;
    }

    const privateAgent = shape === "code-repo" && !sharedFlag;
    const agentName = name ?? basename(targetDir);
    if (agentMode && !isSafeAgentName(agentName)) {
      // The name lands verbatim in YAML frontmatter — refuse rather than escape.
      output.error(
        `Agent name \`${agentName}\` contains characters that don't survive the file's header (allowed: letters, digits, spaces, . _ -). ${name ? "Pick a simpler name." : "This directory's name isn't usable — pass a name: `ideaspaces create <name> --agent`."}`,
      );
      return 5;
    }
    const contractShape: ContractShape = flags.foundation ? "foundation" : "agreement";
    const kind: Kind = agentMode ? "agent" : "knowledge";
    const contract =
      contractShape === "agreement"
        ? agreementContractTemplates(kind, agentName)
        : agentMode
          ? agentContractTemplates(agentName)
          : CONTRACT_TEMPLATES;
    const claudeMd =
      contractShape === "agreement"
        ? agreementClaudeMd(kind, agentName)
        : agentMode
          ? agentClaudeMd(agentName)
          : CLAUDE_MD;
    const plan = buildPlan({ targetDir, name, shape, inspection, privateAgent, contract, contractShape });
    const foundationNote =
      contractShape === "foundation"
        ? "Note: `--foundation` writes the older foundation.md + guide.md shape. It goes away in a later release; new spaces are formed as `_agent/agreement.md`."
        : undefined;

    if (!apply) {
      output.result(
        {
          target: targetDir,
          shape,
          privateAgent,
          agent: agentMode,
          contract: contractShape,
          agreement_reference: contractShape === "agreement" ? KIND_REFERENCES[kind] : null,
          nestedInRepo: inspection.nestedInRepo,
          plan: plan.steps,
        },
        renderPlanText({
          targetDir,
          name,
          shape,
          privateAgent,
          plan,
          nestedInRepo: inspection.nestedInRepo,
          agentName: agentMode ? agentName : undefined,
          foundationNote,
        }),
      );
      return 0;
    }

    let versioned: boolean;
    let gitNote: string | undefined;
    let committablePaths: string[];
    let rootNodeId: string | null;
    try {
      ({ versioned, gitNote, commitPaths: committablePaths, rootNodeId } = await applyPlan({
        targetDir,
        inspection,
        privateAgent,
        contract,
        contractShape,
        claudeMd,
      }));
    } catch (err) {
      // A genuine filesystem failure — the files themselves couldn't be written.
      output.error(`Scaffold failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const where = name ? `./${name}` : "this directory";
    const lines = [
      `Scaffolded ${describeTarget(targetDir, name)} (${agentMode ? `agent: ${agentName}` : shape}${privateAgent ? ", private _agent/" : ""}).`,
    ];
    if (inspection.nestedInRepo) {
      lines.push(nestingNotice(targetDir, inspection.nestedInRepo));
    }
    if (foundationNote) lines.push(foundationNote);
    if (rootNodeId) lines.push(`Space identity: ${rootNodeId}`);
    if (!versioned) {
      lines.push(
        `Working locally — no version history yet. ${gitNote ?? ""}`.trim(),
        `Once git is ready, from ${where}: \`git init -b main && git add ${committablePaths.join(" ")} && git commit -m "Initial ideaspace scaffold"\`.`,
      );
    }
    if (contractShape === "agreement") {
      lines.push(
        agentMode
          ? `Next: open a session in ${where} — the Agreement's sections are prompts. Draw out who ${agentName} is from real tasks and replace them.`
          : `Next: open a session in ${where} — the Agreement's sections are prompts. Draw out what this place is and how work goes here, and replace them.`,
      );
    } else {
      lines.push(
        agentMode
          ? `Next: open Claude Code in ${where} — the agent will read who ${agentName} is and help you shape its character in conversation.`
          : `Next: open Claude Code in ${where} — the agent will read foundation+guide and propose capturing purpose / now / next in conversation.`,
      );
    }
    if (versioned && loadStoredCredentials()) {
      lines.push(`When ready to host this remotely, run \`ideaspaces publish\` from inside ${where}.`);
    }
    output.result(
      {
        target: targetDir,
        shape,
        privateAgent,
        agent: agentMode,
        contract: contractShape,
        agreement_reference: contractShape === "agreement" ? KIND_REFERENCES[kind] : null,
        scaffolded: true,
        versioned,
        root_node_id: rootNodeId,
        identity_state: rootNodeId ? "local_only" : "unstamped_private",
      },
      lines.join("\n"),
    );
    return 0;
  },
};

async function inspect(targetDir: string): Promise<Inspection> {
  const nestedInRepo = enclosingRepoRoot(targetDir);
  if (!existsSync(targetDir)) {
    return {
      exists: false,
      isGitRepo: false,
      nestedInRepo,
      hasFoundation: false,
      hasAgreement: false,
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
  const hasFoundation = existsSync(join(agentDir, "foundation.md"));
  const hasAgreement = existsSync(join(agentDir, "agreement.md"));
  const hasOldAgent =
    existsSync(agentDir) &&
    OLD_AGENT_FILES.some((f) => existsSync(join(agentDir, f))) &&
    !hasFoundation &&
    !hasAgreement;

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
    nestedInRepo,
    hasFoundation,
    hasAgreement,
    hasOldAgent,
    hasClaude,
    hasGitignore,
    hasCodeSignal,
    markdownCount,
  };
}

function detectShape(inspection: Inspection): Shape {
  if (!inspection.exists) return "greenfield";
  // An Agreement is the whole contract. Never scaffold beside one — that would
  // mint a conflicting identity. A Foundation Space is complete in the older
  // shape; it migrates by hand, not by re-running create.
  if (inspection.hasAgreement) return "complete";
  if (inspection.hasFoundation && inspection.hasClaude) return "complete";
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
  contract: Record<string, string>;
  contractShape: ContractShape;
}): Plan {
  const { targetDir, name, inspection, privateAgent, contract, contractShape } = opts;
  const steps: PlanStep[] = [];

  if (name && !inspection.exists) {
    steps.push({ op: "mkdir", path: targetDir });
  }
  if (!inspection.isGitRepo) {
    steps.push({ op: "git-init", path: targetDir });
  }

  for (const fileName of Object.keys(contract)) {
    steps.push({ op: "write", path: join(targetDir, "_agent", `${fileName}.md`) });
  }

  if (contractShape === "foundation") {
    for (const dim of Object.keys(CONVENTION_READMES)) {
      steps.push({
        op: "write",
        path: join(targetDir, "_agent", dim, "README.md"),
        detail: "convention README",
      });
    }
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

  steps.push({ op: "commit", detail: "Initial ideaspace scaffold (scaffold paths only)" });

  return { steps };
}

function renderPlanText(opts: {
  targetDir: string;
  name?: string;
  shape: Shape;
  privateAgent: boolean;
  plan: Plan;
  nestedInRepo: string | null;
  /** Present when scaffolding an agent — the plan must say so before --yes. */
  agentName?: string;
  /** Present under --foundation — the plan must say the shape is the old one. */
  foundationNote?: string;
}): string {
  const { targetDir, name, shape, privateAgent, plan, nestedInRepo, agentName, foundationNote } = opts;
  const lines: string[] = [];
  lines.push(
    `Plan for ${describeTarget(targetDir, name)} — ${agentName ? `agent: ${agentName} (the space IS its character)` : `shape: ${shape}`}${privateAgent ? " (private _agent/)" : ""}`,
  );
  if (nestedInRepo) {
    lines.push("");
    lines.push(nestingNotice(targetDir, nestedInRepo));
  }
  if (foundationNote) {
    lines.push("");
    lines.push(foundationNote);
  }
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
  contract: Record<string, string>;
  contractShape: ContractShape;
  claudeMd: string;
}): Promise<{
  versioned: boolean;
  gitNote?: string;
  commitPaths: string[];
  rootNodeId: string | null;
}> {
  const { targetDir, inspection, privateAgent, contract, contractShape, claudeMd } = opts;
  let rootNodeId: string | null = null;
  let materializedContract = contract;
  if (!privateAgent) {
    // The root entrypoint carries identity: agreement.md, or foundation.md
    // under --foundation.
    const declared = mintDeclaredRootIdentity(contract[contractShape]);
    rootNodeId = declared.rootNodeId;
    materializedContract = { ...contract, [contractShape]: declared.content };
  }

  // Relative paths this scaffold wrote that belong in the initial commit.
  // In the private-_agent/ shape, `_agent/` and CLAUDE.local.md are gitignored
  // by design — they are written but never staged.
  const commitPaths: string[] = [];
  const trackAgent = !privateAgent;

  // 1. Materialize files. The local space always succeeds — git or not.
  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(join(targetDir, "_agent"), { recursive: true });
  for (const [name, content] of Object.entries(materializedContract)) {
    const rel = join("_agent", `${name}.md`);
    await fs.writeFile(join(targetDir, rel), content, "utf-8");
    if (trackAgent) commitPaths.push(rel);
  }

  if (contractShape === "foundation") {
    for (const [dim, content] of Object.entries(CONVENTION_READMES)) {
      const rel = join("_agent", dim, "README.md");
      const abs = join(targetDir, rel);
      if (!existsSync(abs)) {
        await fs.mkdir(join(targetDir, "_agent", dim), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
      }
      if (trackAgent) commitPaths.push(rel);
    }
  }

  const claudeFile = privateAgent ? "CLAUDE.local.md" : "CLAUDE.md";
  if (!inspection.hasClaude) {
    await fs.writeFile(join(targetDir, claudeFile), claudeMd, "utf-8");
    if (!privateAgent) commitPaths.push(claudeFile);
  }

  const gitattributesPath = join(targetDir, ".gitattributes");
  if (!existsSync(gitattributesPath)) {
    await fs.writeFile(gitattributesPath, GITATTRIBUTES, "utf-8");
    commitPaths.push(".gitattributes");
  }

  const gitignorePath = join(targetDir, ".gitignore");
  const existingIgnore = inspection.hasGitignore
    ? await fs.readFile(gitignorePath, "utf-8")
    : null;
  // null means the defaults are already there — leave the file untouched.
  const mergedIgnore = gitignoreWithDefaults(existingIgnore, { privateAgent });
  if (mergedIgnore !== null) {
    await fs.writeFile(gitignorePath, mergedIgnore, "utf-8");
    commitPaths.push(".gitignore");
  }

  // 2. Best-effort git finalize: init → identity → initial commit. Any failure
  // (no git binary, no configured identity, …) leaves the materialized space
  // intact and reports how to add history later — never a partial abort.
  // The commit is pathspec-scoped to what this scaffold wrote: `git add .`
  // followed by a bare commit would sweep anything the user already had
  // staged (or untracked) in an existing repo into the scaffold commit.
  const availability = gitAvailability();
  if (availability.state !== "usable") {
    return { versioned: false, gitNote: availability.hint, commitPaths, rootNodeId };
  }
  try {
    if (!inspection.isGitRepo) {
      runGit(targetDir, ["init", "-q", "-b", "main"]);
    }
    // Set complete repo-local identity before the initial commit so later
    // protocol-effect commits need no credential or network lookup.
    await maybeSetIdentity(targetDir);
    // Never fall through to a bare `git commit` — an empty pathspec list would
    // commit the whole index. Empty only occurs in an existing repo where the
    // scaffold had nothing committable to add (e.g. private _agent/ shape with
    // boundary files already in place).
    if (commitPaths.length) {
      runGit(targetDir, ["add", "--", ...commitPaths]);
      runGit(targetDir, ["commit", "-q", "-m", "Initial ideaspace scaffold", "--", ...commitPaths]);
    }
    return { versioned: true, commitPaths, rootNodeId };
  } catch (err) {
    return {
      versioned: false,
      gitNote: err instanceof Error ? err.message : String(err),
      commitPaths,
      rootNodeId,
    };
  }
}

/** Set complete repo-local IdeaSpaces identity; silent no-op if account resolution fails. */
async function maybeSetIdentity(targetDir: string): Promise<void> {
  const stored = loadStoredCredentials();
  if (!stored) return;
  try {
    // Tighter timeout than the default + no cold-start retry — this is a
    // fire-and-forget best-effort identity wiring; we shouldn't block scaffold
    // for even a couple seconds if the server is slow.
    const me = await fetchAuthMe(
      { apiUrl: stored.api_url, apiKey: stored.api_key },
      { timeoutMs: 2000, retry: false },
    );
    if (!me.username) return;
    runGit(targetDir, ["config", "--local", "user.email", identityEmail(me.username)]);
    runGit(targetDir, [
      "config",
      "--local",
      "user.name",
      identityName({ name: me.name, username: me.username }),
    ]);
  } catch {
    // Don't block create on transient auth/network failure.
  }
}

function runGit(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.error) {
    // Spawn failure (e.g. git not on PATH) — status is null, streams undefined.
    throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const message = (r.stderr ?? "").trim() || (r.stdout ?? "").trim() || `exit ${r.status}`;
    throw new Error(`git ${args.join(" ")}: ${message}`);
  }
}

/**
 * Real path of `target`, resolving symlinks on the portion that already exists
 * and re-appending the not-yet-created tail. Needed because git reports
 * realpaths while `resolve()`-d user input keeps symlinks (e.g. macOS `/tmp` →
 * `/private/tmp`) — comparing or relativizing the two raw forms is wrong.
 */
function effectiveRealPath(target: string): string {
  let probe = target;
  const suffix: string[] = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) return target; // nothing on the path exists
    suffix.unshift(basename(probe));
    probe = parent;
  }
  const real = realpathSync.native(probe);
  return suffix.length ? join(real, ...suffix) : real;
}

/**
 * Root of a git repo that *encloses* `targetDir` without being it — the parent
 * repo a new nested ideaspace would land inside. Returns null when the target
 * isn't under any repo, or is itself a repo root (then there's no nesting).
 * Probes from the nearest existing ancestor so it works before the dir exists.
 */
function enclosingRepoRoot(targetDir: string): string | null {
  let probe = targetDir;
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) return null;
    probe = parent;
  }
  const r = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const reportedRoot = r.stdout.trim();
  if (!reportedRoot) return null;
  const root = realpathSync.native(reportedRoot);
  // Compare against the target's real path so "is the target itself the repo
  // root?" holds even when git's toplevel is a realpath (notably on macOS).
  return root !== effectiveRealPath(targetDir) ? root : null;
}

/** Heads-up that a new repo is being nested inside an existing one. */
function nestingNotice(targetDir: string, parentRoot: string): string {
  // Relativize against the target's real path: parentRoot is git's realpath, so
  // a raw symlinked targetDir would yield a bogus `../../` traversal hint.
  const rel = (relative(parentRoot, effectiveRealPath(targetDir)) || basename(targetDir))
    .split(sep)
    .join("/");
  return (
    `Note: this folder is inside git repo ${parentRoot}.\n` +
    `  Creating an independent ideaspace repo here — ${parentRoot} will see \`${rel}/\` as an untracked nested repo.\n` +
    `  Add \`${rel}/\` to ${join(parentRoot, ".gitignore")} to keep them separate.`
  );
}

function describeTarget(targetDir: string, name?: string): string {
  return name ? `./${basename(targetDir)}` : "the current directory";
}
