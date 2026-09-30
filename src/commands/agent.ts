import { parseFrontmatter } from "@ideaspaces/protocol";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { preferredContractSource } from "../contract-source.js";
import { loadMapNote } from "../local/map-note.js";
import { enteredThroughRoot, isContained } from "../local/contained-path.js";
import { changeLaunchSets, inspectLaunchSet, readLaunchSets, selectApprovedLaunch, validLaunchSetName } from "../local/child-launch-approval.js";
import { prepareThreadLaunch, withThreadSnapshot } from "../local/thread-launch.js";
import { appendPost } from "../local/threads.js";
import { formatMapAgentsText, projectMapAgents } from "../local/map-agents.js";
import {
  resolveAgentPov,
  revalidateAgentPov,
  validateAgentPov,
  type AgentPovErrorCode,
  type AgentPovResult,
  type InvalidAgentPov,
  type ValidAgentPov,
  type ValidateAgentPovOptions,
} from "../local/agent-pov.js";
import { createOutput, type Output } from "../output.js";
import type { LocalConversationOps } from "./conversation.js";
import {
  DEFAULT_LOCAL_RUNTIME,
  isLocalRuntime,
  LOCAL_RUNTIMES,
  type LocalRuntime,
} from "../local/runtime.js";
import type { CommandDef, GlobalFlags } from "../types.js";

export {
  resolveAgentPov,
  revalidateAgentPov,
  validateAgentPov,
  type AgentPovErrorCode,
  type AgentPovResult,
  type InvalidAgentPov,
  type ValidAgentPov,
  type ValidateAgentPovOptions,
};

type Flags = Record<string, string | boolean>;

// Both child Pi RPC and Claude Code receive orientation via
// --append-system-prompt argv; both adapters pass the message to this CLI on
// --message argv before the CLI relays it to the child via RPC/stdin. Reserve
// room for executable paths and runtime flags on Windows.
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_ORIENTATION_BYTES = 16 * 1024;

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const RUN_ARGS = "<pov> --message <text> [--runtime pi|claude] [--model <name>] [--pi-thinking <level>] [--pi-trust saved|explicit] [--launch-set <name> | --ext <approved-paths> [--skill <approved-dirs>]] (Pi) [--claude-effort <level>] [--permission-mode <mode>] [--read-only] [--map <note>] [--conversation <id>] [--thread <path> --thread-map <note> --thread-member <ordinal>] [--json]";
export const RUN_USAGE = `ideaspaces agent run ${RUN_ARGS}`;

export const LIST_USAGE =
  "ideaspaces agent list --map <file> [--json]";

export const USAGE =
  `ideaspaces agent <run|list|launch-set> … (run ${RUN_ARGS}; list --map <file> [--json]; launch-set approve|revoke|list)`;

export interface AgentDefaults {
  runtime?: LocalRuntime;
  model?: string;
  pi_model?: string;
  claude_model?: string;
}

/**
 * Read the default runtime and model declared in the POV's Agreement or Foundation frontmatter,
 * following standard CLI contract precedence via `preferredContractSource`.
 */
export function readAgentDefaults(povPath: string): AgentDefaults {
  const available = [
    ...(existsSync(join(povPath, "_agent", "agreement.md")) ? ["agreement" as const] : []),
    ...(existsSync(join(povPath, "_agent", "foundation.md")) ? ["foundation" as const] : []),
  ];
  const source = preferredContractSource(available);
  if (!source) return {};

  const contractPath = join(povPath, "_agent", `${source}.md`);

  try {
    const content = readFileSync(contractPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm || typeof fm !== "object") return {};

    const defaults: AgentDefaults = {};
    if (typeof fm.runtime === "string" && isLocalRuntime(fm.runtime.trim())) {
      defaults.runtime = fm.runtime.trim() as LocalRuntime;
    }
    if (typeof fm.model === "string" && fm.model.trim()) {
      defaults.model = fm.model.trim();
    }
    if (typeof fm.claude_model === "string" && fm.claude_model.trim()) {
      defaults.claude_model = fm.claude_model.trim();
    }
    if (typeof fm.pi_model === "string" && fm.pi_model.trim()) {
      defaults.pi_model = fm.pi_model.trim();
    }
    return defaults;
  } catch {
    return {};
  }
}

async function cmdRun(
  args: string[],
  flags: Flags,
  local: LocalConversationOps,
  output: Output,
): Promise<number> {
  const povArg = args[0];
  if (!povArg) {
    output.error(`Usage: ${RUN_USAGE}`);
    return 1;
  }

  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
    output.error("Agent launch message exceeds 8 KiB; use a shorter instruction or point to a local Note.");
    return 1;
  }

  const povResult = validateAgentPov(povArg);
  if (!povResult.valid) {
    output.error(povResult.message);
    return 1;
  }
  const povPath = povResult.path; // validateAgentPov returns the realpath, including symlinked ancestors
  // The selected contract, not the caller's SessionStart, owns this child POV.
  // Child hooks may also run, but launch must be grounded even when that
  // other harness has no IdeaSpaces plugin installed yet.
  let povOrientation: string;
  try {
    // Preflight before reading a possibly huge Agreement into memory.
    if (statSync(povResult.contractPath).size > MAX_ORIENTATION_BYTES) {
      output.error("Selected POV Agreement exceeds 16 KiB; shorten it before launch.");
      return 1;
    }
    const contract = readFileSync(povResult.contractPath, "utf8");
    povOrientation = `[Selected ${povResult.contractType} POV: ${povPath}]\n${contract}`;
    if (Buffer.byteLength(povOrientation) > MAX_ORIENTATION_BYTES) {
      output.error("Selected POV orientation exceeds 16 KiB; shorten the Agreement before launch.");
      return 1;
    }
  } catch (err) {
    output.error(`Could not read the selected POV contract: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let thread: ReturnType<typeof prepareThreadLaunch> | undefined;
  if (["thread", "thread-map", "thread-member"].some((key) => flags[key] !== undefined)) {
    const path = flagString(flags, "thread");
    const map = flagString(flags, "thread-map");
    const member = flagString(flags, "thread-member");
    if (!path || !map || member === undefined) {
      output.error("A local Thread launch requires --thread <path> --thread-map <authored-note> --thread-member <ordinal>; a path alone has no pin. Use `threads open <path> --map <note> --member <ordinal>` to check the authored selection.");
      return 1;
    }
    try {
      thread = prepareThreadLaunch(povPath, path, map, member);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      output.error(`Cannot launch from local Thread: ${detail.replace(/--member\b/g, "--thread-member").replace(/--map\b/g, "--thread-map")}`);
      return 1;
    }
  }

  if (thread && Buffer.byteLength(`${povOrientation}\n\n${thread.orientation}`) > MAX_ORIENTATION_BYTES) {
    output.error("Combined Agreement and Thread orientation exceeds 16 KiB; shorten the selected frame before launch.");
    return 1;
  }
  const currentPov = revalidateAgentPov(povPath);
  if (!currentPov.valid || currentPov.contractPath !== povResult.contractPath) {
    output.error("Selected POV contract moved or became invalid before launch; select it again.");
    return 1;
  }

  const defaults = readAgentDefaults(povPath);

  let runtime: LocalRuntime;
  if (flags.runtime !== undefined && flags.runtime !== false) {
    if (typeof flags.runtime !== "string" || !isLocalRuntime(flags.runtime)) {
      output.error(
        `Unknown local runtime "${String(flags.runtime)}". Valid values: ${LOCAL_RUNTIMES.join(", ")}`,
      );
      return 1;
    }
    runtime = flags.runtime;
  } else if (defaults.runtime) {
    runtime = defaults.runtime;
  } else {
    runtime = DEFAULT_LOCAL_RUNTIME;
  }

  let model: string | undefined;
  if (typeof flags.model === "string" && flags.model.trim()) {
    model = flags.model.trim();
  } else if (runtime === "pi" && typeof flags["pi-model"] === "string" && flags["pi-model"].trim()) {
    model = flags["pi-model"].trim();
  } else if (runtime === "claude" && typeof flags["claude-model"] === "string" && flags["claude-model"].trim()) {
    model = flags["claude-model"].trim();
  } else if (defaults.model) {
    model = defaults.model;
  } else if (runtime === "pi" && defaults.pi_model) {
    model = defaults.pi_model;
  } else if (runtime === "claude" && defaults.claude_model) {
    model = defaults.claude_model;
  }

  const selectedPaths: { ext: string[]; skill: string[] } = { ext: [], skill: [] };
  let approvalName: string | undefined;
  if (runtime === "claude" && (flags.ext !== undefined || flags.skill !== undefined || flags["launch-set"] !== undefined)) {
    output.error("Pi --launch-set, --ext and --skill are unavailable under Claude; choose --runtime pi or omit them.");
    return 1;
  }
  if (runtime === "pi") {
    if (flags["launch-set"] !== undefined && !flagString(flags, "launch-set")) {
      output.error("--launch-set needs an approved name; use agent launch-set list to see available names.");
      return 1;
    }
    if (flags["launch-set"] === undefined && (typeof flags.ext !== "string" || !flags.ext.split(",").some((path) => path.trim()))) {
      output.error("Pi child launch needs an approved named set; no child was started.\nPass --launch-set <name>, or --ext/--skill paths matching an approved set. Approve from a trusted terminal with agent launch-set approve; installed packages, target content and IDEASPACES_PI_EXTENSIONS grant nothing.");
      return 1;
    }
    if (flags.skill !== undefined && typeof flags.skill !== "string") {
      output.error("Pi child skills require --skill <comma-separated-dirs>; a bare flag selects nothing.");
      return 1;
    }
    // A path selected from inside the child repo cannot smuggle executable code
    // through a symlink outside it. Explicit external paths are caller-selected,
    // never inferred from the repo's declarations.
    for (const key of ["ext", "skill"] as const) {
      if (typeof flags[key] !== "string") continue;
      for (const raw of flags[key].split(",").map((s) => s.trim()).filter(Boolean)) {
        const path = isAbsolute(raw) ? raw : resolve(povPath, raw);
        if (!existsSync(path)) {
          output.error(`Refusing ${key} path ${raw}: path not found. Select an installed, reviewed path before launch.`);
          return 1;
        }
        try {
          const canonical = realpathSync(path);
          if (enteredThroughRoot(povPath, path) && !isContained(povPath, canonical)) {
            throw new Error("escapes the selected POV");
          }
          selectedPaths[key].push(canonical);
        } catch (err) {
          output.error(`Refusing ${key} path ${raw}: ${err instanceof Error ? err.message : String(err)}. Select an explicit reviewed path instead.`);
          return 1;
        }
      }
    }
    try {
      const approved = selectApprovedLaunch(flagString(flags, "launch-set"), selectedPaths.ext, selectedPaths.skill);
      approvalName = approved.name;
      selectedPaths.ext = approved.set.extensions;
      selectedPaths.skill = approved.set.skills;
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (flags["session-dir"] !== undefined) {
    output.error("agent run uses the selected POV's session directory; --session-dir cannot redirect its transcript.");
    return 1;
  }
  if (flags.conversation !== undefined) {
    if (typeof flags.conversation !== "string" || !flags.conversation.trim()) {
      output.error("Resume requires --conversation <existing-id> at the selected POV.");
      return 1;
    }
    if (!local.canResume?.(povPath, flags.conversation, runtime)) {
      output.error(`No verified nonempty ${runtime} conversation ${flags.conversation} at the selected POV (${povPath}). Start a new turn without --conversation, or use an id from conversations --local --runtime ${runtime} --context <pov>.`);
      return 1;
    }
    const resumePov = revalidateAgentPov(povPath);
    if (!resumePov.valid || resumePov.contractPath !== povResult.contractPath) {
      output.error("Selected POV contract changed before resume; select it again.");
      return 1;
    }
  }

  const forwardFlags: Flags = {
    ...flags,
    local: true,
    context: povPath,
    runtime,
    message,
  };
  // Keep Desktop's legacy conversation-send default intact, but never approve
  // an agent run's Pi project resources merely because the CLI was invoked.
  if (runtime === "pi" && flags["pi-trust"] === undefined) forwardFlags["pi-trust"] = "saved";

  if (runtime === "pi" && (flags["read-only"] === true || flags["claude-effort"] !== undefined || flags["permission-mode"] !== undefined)) {
    output.error("Claude read-only, effort, and permission mode are unavailable under Pi. Choose --runtime claude or omit them.");
    return 1;
  }
  if (runtime === "claude" && (flags["pi-thinking"] !== undefined || flags["pi-trust"] !== undefined)) {
    output.error("Pi thinking and trust policy are unavailable under Claude; use --claude-effort if supported.");
    return 1;
  }

  if (model) {
    if (runtime === "pi") {
      forwardFlags["pi-model"] = model;
    } else if (runtime === "claude") {
      forwardFlags["claude-model"] = model;
    }
  }

  // Pass the vetted realpaths, not names or symlinks that could move before spawn.
  const launchOptions = {
    extensionPaths: [...new Set(selectedPaths.ext)],
    skillPaths: [...new Set(selectedPaths.skill)],
    approvalName,
    resumeOnly: flags.conversation !== undefined,
  };
  if (!thread) return local.send(forwardFlags, output, { ...launchOptions, extraOrientation: povOrientation });
  let snapshotWritten = false;
  return local.send(forwardFlags, output, {
    ...launchOptions,
    extraOrientation: `${povOrientation}\n\n${thread.orientation}`,
    onEvent(event) {
      if (event.type !== "turn_complete") return event;
      if (snapshotWritten) throw new Error("Runtime emitted a second completion; refusing a duplicate Thread snapshot.");
      const response = event.result.response;
      if (!response?.trim()) throw new Error("Agent completed without a closing response.");
      const { post, path } = appendPost(thread.directory, {
        body: response, author: thread.agentName, name: `Snapshot — ${thread.agentName}`,
        summary: response.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 200),
        kind: "snapshot", replyTo: [thread.parentId], map: thread.citation,
      });
      snapshotWritten = true;
      output.progress(`Thread snapshot: ${path}`);
      return withThreadSnapshot(event, post.id, path);
    },
  });
}

type HumanConfirm = (review: string, phrase: string) => Promise<boolean>;

const confirmOnTerminal: HumanConfirm = async (review, phrase) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.PI_AGENT_SESSION_DEPTH || process.env.IS_COLLABORATE_DEPTH) {
    throw new Error("Approval needs a person's interactive terminal; agent/model tools and non-interactive hosts cannot write it.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`${review}\nType '${phrase}' to confirm: `);
    return (await prompt.question("")) === phrase;
  } finally { prompt.close(); }
};

function commaPaths(value: string | boolean | undefined, base: string): string[] {
  return typeof value === "string" ? value.split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(base, path)) : [];
}

async function cmdLaunchSet(args: string[], flags: Flags, global: GlobalFlags, output: Output, confirm: HumanConfirm): Promise<number> {
  const [action, name] = args;
  try {
    if (action === "list") {
      const sets = Object.entries(readLaunchSets().sets).map(([id, set]) => ({ name: id, packages: set.packages.map(({ name, version }) => ({ name, version })) }));
      output.result({ sets }, sets.length ? sets.map((set) => `${set.name} — ${set.packages.map((p) => `${p.name}@${p.version}`).join(", ")}`).join("\n") : "No approved child launch sets.");
      return 0;
    }
    if ((action !== "approve" && action !== "revoke") || !name || !validLaunchSetName(name) || args.length !== 2) {
      output.error("Usage: ideaspaces agent launch-set approve <name> --ext <path,path> [--skill <dir,dir>] | revoke <name> | list");
      return 1;
    }
    if (global.yes) throw new Error("--yes cannot approve or revoke child execution; review it in an interactive terminal.");
    if (action === "approve") {
      if (typeof flags.ext !== "string" || !flags.ext.trim() || (flags.skill !== undefined && typeof flags.skill !== "string")) throw new Error("Approve needs --ext <paths> and optional --skill <dirs>.");
      const set = inspectLaunchSet(commaPaths(flags.ext, process.cwd()), commaPaths(flags.skill, process.cwd()));
      const review = [`Child execution approval: ${name}`, "The selected code runs with your account. Review every path and exact digest:",
        ...set.packages.map((p) => `${p.name}@${p.version} sha256:${p.digest} (${p.root})`),
        ...set.extensions.map((p) => `extension: ${p}`), ...set.skills.map((p) => `skill: ${p}`)].join("\n");
      if (!(await confirm(review, name))) throw new Error("Approval cancelled; no record changed.");
      // Hash again after review so a changed file cannot be approved on stale evidence.
      const current = inspectLaunchSet(set.extensions, set.skills);
      if (JSON.stringify(current) !== JSON.stringify(set)) throw new Error("Package changed during review; inspect it again before approving.");
      changeLaunchSets((store) => { store.sets[name] = current; });
      output.result({ name, packages: current.packages.map(({ name, version, digest }) => ({ name, version, digest })) }, `Approved child set ${name}`);
    } else {
      if (flags.ext !== undefined || flags.skill !== undefined) throw new Error("Revoke takes only the set name.");
      if (!readLaunchSets().sets[name]) throw new Error(`No approved set named ${name}.`);
      if (!(await confirm(`Revoke child execution approval: ${name}`, `revoke ${name}`))) throw new Error("Revocation cancelled; no record changed.");
      changeLaunchSets((store) => { delete store.sets[name]; });
      output.result({ name, revoked: true }, `Revoked child set ${name}`);
    }
    return 0;
  } catch (error) { output.error(error instanceof Error ? error.message : String(error)); return 1; }
}

function cmdList(
  flags: Flags,
  global: GlobalFlags,
  output: Output,
): number {
  const mapPath = flagString(flags, "map");
  if (!mapPath) {
    output.error(`--map <file> is required.\nUsage: ${LIST_USAGE}`);
    return 1;
  }

  const contextRoot = global.repo ? resolve(global.repo) : process.cwd();
  let loadedMap;
  try {
    loadedMap = loadMapNote(mapPath, contextRoot);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const result = projectMapAgents(loadedMap, { cwd: contextRoot });
  const text = formatMapAgentsText(result);
  output.result(result, text);
  return 0;
}

export function makeAgentCommand(local: LocalConversationOps, confirm: HumanConfirm = confirmOnTerminal): CommandDef {
  return {
    name: "agent",
    description: "Run or list local POVs and approve named child Pi resource sets from a person's terminal. Pi runs require --launch-set <approved-name> or --ext/--skill paths matching that approval; no default or ambient consent. --conversation resumes an existing nonempty POV transcript; --session-dir is refused. Pi project trust defaults to saved. --read-only restricts Claude to Read/Grep/Glob (not a filesystem sandbox). Message <=8 KiB; combined Agreement/Thread orientation <=16 KiB. Pinned Thread runs append a named snapshot.",
    usage: USAGE,
    examples: [
      "ideaspaces agent list --map home.map.md",
      "ideaspaces agent list --map home.map.md --json",
      "ideaspaces agent run agents/scout --message 'Check findings' --runtime claude --model sonnet --read-only --claude-effort high",
      "ideaspaces agent launch-set approve core --ext /path/pi-is-space/src/index.ts,/path/pi-local-context/src/index.ts --skill /path/pi-is-space/skills,/path/pi-local-context/skills",
      "ideaspaces agent run agents/scout --message 'Continue' --runtime pi --launch-set core --pi-trust saved --pi-thinking high",
      "ideaspaces agent run agents/scout --message 'Check findings' --runtime pi --launch-set core",
      "ideaspaces agent run agents/scout --message 'Resume turn' --conversation <existing-id>",
      "ideaspaces agent run agents/scout --thread _threads/decision --thread-map handoff.map.md --thread-member 0 --message 'Continue'",
      "ideaspaces agent run n_0935a5df1f883eeb60bcdfbb --message 'Hello from root id' --runtime claude",
    ],
    async run(args, flags, global: GlobalFlags) {
      const output = createOutput(global);
      const [sub, ...rest] = args;
      switch (sub) {
        case "run":
          return cmdRun(rest, flags, local, output);
        case "list":
          return cmdList(flags, global, output);
        case "launch-set":
          return cmdLaunchSet(rest, flags, global, output, confirm);
        default:
          output.error(`Usage: ${USAGE}`);
          return 1;
      }
    },
  };
}

export const agentCommand: CommandDef = makeAgentCommand({
  send: async () => 1,
  createNew: () => 1,
  get: () => 1,
  list: () => 1,
});
