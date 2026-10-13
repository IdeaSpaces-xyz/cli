import { parseFrontmatter } from "@ideaspaces/protocol";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { KeeperStreamEvent } from "@ideaspaces/sdk";
import type { LocalMessageStartEvent } from "../local/send-options.js";
import { discoverAgentReach } from "../local/agent-reach.js";
import { CLAUDE_HANDOVER_TOOLS, CLAUDE_READ_TOOLS } from "../local/claude-tool-policy.js";
import { preferredContractSource } from "../contract-source.js";
import { loadMapNote } from "../local/map-note.js";
import { enteredThroughRoot, isContained } from "../local/contained-path.js";
import { expandHomePath } from "../local/expand-home-path.js";
import { prepareHostedThreadLaunch, prepareThreadLaunch, withThreadSnapshot, type HostedThreadLaunch, type PinnedThreadLaunch } from "../local/thread-launch.js";
import { appendPost } from "../local/threads.js";
import { formatMapAgentsText, projectMapAgents } from "../local/map-agents.js";
import { agentRunCapabilities, formatAgentRunCapabilities } from "../local/agent-capabilities.js";
import {
  deriveTask,
  formatAgentRunsText,
  listAgentRuns,
  recordAgentRun,
  type AgentRunRecord,
} from "../local/agent-runs.js";
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

/** Pi's pi-is-space extension injects the selected POV Agreement via Awareness. */
function piAwarenessSelected(extensionPaths: string[]): boolean {
  return extensionPaths.some((path) => {
    const dir = path.endsWith("/src/index.ts") ? dirname(dirname(path)) : path;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; pi?: { extensions?: string[] } };
      return pkg.name === "@ideaspaces/pi-is-space" && Array.isArray(pkg.pi?.extensions) &&
        pkg.pi.extensions.some((entry) => typeof entry === "string" && existsSync(resolve(dir, entry)) &&
          isContained(dir, realpathSync(resolve(dir, entry))) && (dir === path || realpathSync(resolve(dir, entry)) === path));
    } catch { return false; }
  });
}

const RUN_ARGS = "<pov> --message <text> [--task <text>] [--runtime pi|claude] [--model <name>] [--parent <id>] [--parent-tool-use-id <id>] [--run-id <id>] [--pi-thinking <level>] [--pi-trust saved|explicit] --ext <paths|pi-is-space,pi-local-context> (required for Pi) [--skill <dirs>] [--claude-effort <level>] [--permission-mode <mode>] [--read-only] [--reach <dir> ...] [--map <note>] [--conversation <id>] [--thread <path|x_id> [--thread-map <note> --thread-member <ordinal>]] [--json]";
export const RUN_USAGE = `ideaspaces agent run ${RUN_ARGS}`;

export const RUNS_USAGE =
  "ideaspaces agent runs [--parent <id>] [--agent <path>] [--limit <n>] [--json]";

export const LIST_USAGE =
  "ideaspaces agent list --map <file> [--json]";

export const CAPABILITIES_USAGE = "ideaspaces agent capabilities [--json]";

export const USAGE =
  `ideaspaces agent <run|runs|list|capabilities> … (run ${RUN_ARGS}; runs [--parent <id>] [--agent <path>] [--limit <n>] [--json]; list --map <file> [--json]; capabilities [--json])`;

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
  outerOutput: Output,
  jsonMode: boolean,
): Promise<number> {
  let launched = false;
  const output: Output = { ...outerOutput, error(message) {
    outerOutput.error(message);
    if (jsonMode && !launched) process.stdout.write(`${JSON.stringify({ type: "error", error_type: "run_preflight", message })}\n`);
  } };
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

  let thread: PinnedThreadLaunch | HostedThreadLaunch | undefined;
  if (["thread", "thread-map", "thread-member"].some((key) => flags[key] !== undefined)) {
    const path = flagString(flags, "thread");
    const map = flagString(flags, "thread-map");
    const member = flagString(flags, "thread-member");
    if (!path) {
      output.error("A local Thread launch requires --thread <path> --thread-map <authored-note> --thread-member <ordinal>; a path alone has no pin. Use `threads open <path> --map <note> --member <ordinal>` to check the authored selection.");
      return 1;
    }
    if (/^x_[0-9a-f]{12,24}$/.test(path)) {
      if (flags["thread-map"] !== undefined || flags["thread-member"] !== undefined) {
        output.error("Hosted Thread launches use --thread <x_id> alone; omit --thread-map and --thread-member.");
        return 1;
      }
      try {
        thread = await prepareHostedThreadLaunch(povPath, path);
      } catch (err) {
        output.error(`Cannot launch from hosted Thread: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    } else {
      if (!map || member === undefined) {
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
  if (runtime === "claude" && (flags.ext !== undefined || flags.skill !== undefined)) {
    output.error("Pi --ext and --skill paths are unavailable under Claude; choose --runtime pi or omit them.");
    return 1;
  }
  if (runtime === "pi") {
    if (typeof flags.ext !== "string" || !flags.ext.split(",").some((path) => path.trim())) {
      output.error("Pi child launch needs an explicit approved extension selection; no child was started.\nPass --ext pi-is-space,pi-local-context for packages already installed in Pi, or --ext <path1,path2> (and --skill <dirs> if needed). Relative paths resolve from the selected POV. No installed package or IDEASPACES_PI_EXTENSIONS is selected without --ext.");
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
        // Shells do not expand ~ after a comma; do so per approved item. Named
        // installed packages are an explicit selector, never ambient discovery.
        const expanded = expandHomePath(raw);
        const installed = key === "ext" && (raw === "pi-is-space" || raw === "pi-local-context")
          ? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "npm", "node_modules", "@ideaspaces", raw)
          : undefined;
        const path = installed && existsSync(installed) ? installed : isAbsolute(expanded) ? expanded : resolve(povPath, expanded);
        if (!existsSync(path)) {
          output.error(`Refusing ${key} path ${raw}: path not found. Select an installed, reviewed path before launch.`);
          return 1;
        }
        try {
          const canonical = realpathSync(path);
          if (installed && path === installed) {
            const pkg = JSON.parse(readFileSync(join(canonical, "package.json"), "utf8")) as { name?: string; pi?: { extensions?: string[] } };
            if (pkg.name !== `@ideaspaces/${raw}` || !Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length === 0 ||
              !pkg.pi.extensions.every((entry) => typeof entry === "string" && existsSync(resolve(canonical, entry)) && isContained(canonical, realpathSync(resolve(canonical, entry))))) {
              throw new Error("installed Pi package has no valid IdeaSpaces extension entry");
            }
          }
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
  // `agent run` has already validated and rendered the Thread. Do not ask the
  // underlying conversation send to launch it again (double context, double fetch).
  delete forwardFlags.thread;
  delete forwardFlags["thread-map"];
  delete forwardFlags["thread-member"];
  // Keep Desktop's legacy conversation-send default intact, but never approve
  // an agent run's Pi project resources merely because the CLI was invoked.
  if (runtime === "pi" && flags["pi-trust"] === undefined) forwardFlags["pi-trust"] = "saved";

  if (flags.reach === true) {
    output.error("--reach requires a directory path: --reach <dir>");
    return 1;
  }
  if (runtime === "pi" && (flags["read-only"] === true || flags["claude-effort"] !== undefined || flags["permission-mode"] !== undefined || flags.reach !== undefined)) {
    output.error("Claude read-only, effort, reach, and permission mode are unavailable under Pi. Choose --runtime claude or omit them.");
    return 1;
  }
  if (runtime === "claude" && flags["permission-mode"] === "bypassPermissions") {
    output.error("agent run does not permit --permission-mode bypassPermissions; use --permission-mode acceptEdits (default).");
    return 1;
  }
  if (runtime === "claude" && flags["permission-mode"] === "auto") {
    output.error("Claude Code cannot reliably set auto by --permission-mode flag in supported headless versions. Use acceptEdits or configure auto in Claude Code settings outside agent run.");
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

  const noReach = { addedDirs: [] as string[], errors: [] as string[], warnings: [] as string[] };
  const reachResult = runtime === "claude" ? discoverAgentReach({
    povPath,
    mapFlag: flagString(flags, "map"),
    reachFlag: Array.isArray(flags.reach) || typeof flags.reach === "string" ? flags.reach : undefined,
    cwd: process.cwd(),
  }) : noReach;
  if (reachResult.errors.length > 0) {
    for (const err of reachResult.errors) output.error(err);
    return 1;
  }
  for (const warning of reachResult.warnings) output.log(`Reach warning: ${warning}`);
  if (runtime === "claude") output.progress(`Claude ${flags["read-only"] === true ? "read-only" : "writable"} reach: ${[povPath, ...reachResult.addedDirs].join(", ")}`);

  // Pass the vetted realpaths, not names or symlinks that could move before spawn.
  const launchOptions = {
    extensionPaths: [...new Set(selectedPaths.ext)],
    skillPaths: [...new Set(selectedPaths.skill)],
    addedDirs: runtime === "claude" ? reachResult.addedDirs : [],
    ...(runtime === "claude" ? { allowedTools: flags["read-only"] === true ? [...CLAUDE_READ_TOOLS] : [...CLAUDE_HANDOVER_TOOLS] } : {}),
    agentRun: true,
    resumeOnly: flags.conversation !== undefined,
  };

  const parentId = flagString(flags, "parent") ?? process.env.IDEASPACES_PARENT_RUN_ID ?? process.env.IDEASPACES_PARENT_ID ?? process.env.PI_SESSION_ID ?? null;
  const parentToolUseId = flagString(flags, "parent-tool-use-id") ?? process.env.PARENT_TOOL_USE_ID ?? null;
  const runId = flagString(flags, "run-id") ?? process.env.IDEASPACES_RUN_ID ?? `run-${randomUUID()}`;
  const task = flagString(flags, "task") ?? deriveTask(message, process.cwd());

  const runRecord: AgentRunRecord = {
    run_id: runId,
    parent_id: parentId,
    parent_tool_use_id: parentToolUseId,
    agent: povPath,
    task,
    harness: runtime,
    model: model ?? null,
    model_requested: model ?? null,
    model_observed: null,
    conversation_id: flags.conversation ? String(flags.conversation) : null,
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
  };
  recordAgentRun(runRecord);
  launched = true;

  function finishRun(status: AgentRunRecord["status"]) {
    if (runRecord.ended_at === null) {
      runRecord.status = status;
      runRecord.ended_at = new Date().toISOString();
      recordAgentRun(runRecord);
    }
  }

  let terminalEmitted = false;
  function handleRunEvent(event: KeeperStreamEvent): KeeperStreamEvent {
    if (event.type === "message_start") {
      const msgStart = event as LocalMessageStartEvent;
      if (typeof msgStart.conversation_id === "string") runRecord.conversation_id = msgStart.conversation_id;
      if (msgStart.model_observed !== undefined) {
        runRecord.model_observed = msgStart.model_observed;
        if (msgStart.model_observed) runRecord.model = msgStart.model_observed;
      }
      if (msgStart.model_requested !== undefined) runRecord.model_requested = msgStart.model_requested;
      recordAgentRun(runRecord);
    } else if (event.type === "turn_complete") {
      terminalEmitted = true;
      finishRun("completed");
    } else if (event.type === "error") {
      terminalEmitted = true;
      finishRun("failed");
    } else if (event.type === "cancelled") {
      terminalEmitted = true;
      finishRun("failed");
      // An unattended launcher needs a cause, not a silent cancelled run.
      return { type: "error", error_type: "run_cancelled", message: `${runtime} run cancelled: ${event.reason}. Resume conversation ${runRecord.conversation_id ?? "from message_start"} to continue.` };
    }
    return event;
  }

  let onEvent = handleRunEvent;
  if (thread && thread.kind !== "hosted") {
    let snapshotWritten = false;
    const baseOnEvent = onEvent;
    onEvent = (event) => {
      let current = event;
      if (event.type === "turn_complete") {
        try {
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
          current = withThreadSnapshot(event, post.id, path);
        } catch (err) {
          current = { type: "error", error_type: "thread_snapshot", message: `Run completed but Thread snapshot was not appended: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return baseOnEvent(current);
    };
  }

  // Only drop the duplicate for a positively identified pi-is-space package.
  // Arbitrary approved extensions may not inject Awareness, so keep the selected
  // POV contract in their system prompt; Claude always needs it from the CLI.
  const contractOrientation = runtime === "pi" && piAwarenessSelected(launchOptions.extensionPaths) ? undefined : povOrientation;
  const extraOrientation = [contractOrientation, thread?.orientation].filter(Boolean).join("\n\n") || undefined;
  // The runtime adapters own SIGINT/SIGTERM: they abort the child and emit a
  // terminal cancellation. A second handler here used to kill the CLI before
  // that event could reach a launcher.
  let exitCode = 1;
  let lastLocalError: string | undefined;
  const runOutput: Output = {
    ...output,
    error(message) {
      lastLocalError = message;
      output.error(message);
    },
  };
  try {
    exitCode = await local.send(forwardFlags, runOutput, {
      ...launchOptions,
      extraOrientation,
      threadReceipt: thread?.receipt,
      onEvent,
    });
    if (!terminalEmitted) {
      const error = { type: "error" as const, error_type: "run_incomplete", message: lastLocalError
        ? `Agent run ended before turn_complete: ${lastLocalError}`
        : `Agent runtime exited (code ${exitCode}) without turn_complete or an error event; resume conversation ${runRecord.conversation_id ?? "from message_start"} to continue its last step.` };
      handleRunEvent(error);
      if (jsonMode) process.stdout.write(`${JSON.stringify(error)}\n`);
      else output.error(`${error.error_type}: ${error.message}`);
      exitCode = 1;
    }
    return exitCode;
  } catch (err) {
    const error = { type: "error" as const, error_type: "run_exception", message: `Agent run failed: ${err instanceof Error ? err.message : String(err)}. Resume conversation ${runRecord.conversation_id ?? "from message_start"} to continue its last step.` };
    handleRunEvent(error);
    if (jsonMode) process.stdout.write(`${JSON.stringify(error)}\n`);
    else output.error(`${error.error_type}: ${error.message}`);
    return 1;
  } finally {
    finishRun(exitCode === 0 ? "completed" : "failed");
  }
}

function cmdRuns(
  flags: Flags,
  output: Output,
): number {
  const parentId = flagString(flags, "parent");
  const agentFilter = flagString(flags, "agent");
  const limitRaw = flagString(flags, "limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = parseInt(limitRaw, 10);
    if (isNaN(parsed) || parsed <= 0 || String(parsed) !== limitRaw.trim()) {
      output.error("Invalid --limit: must be a positive integer");
      return 1;
    }
    limit = parsed;
  }

  const runs = listAgentRuns({ parentId, agent: agentFilter, limit });
  const text = formatAgentRunsText(runs, parentId);
  output.result({ runs, total: runs.length }, text);
  return 0;
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

export function makeAgentCommand(local: LocalConversationOps): CommandDef {
  return {
    name: "agent",
    description: "Run or list local POVs. Launchers check `agent capabilities --json` for what run guarantees, never this help text. Claude adds the enclosing Space and Map checkouts automatically; repeat --reach <dir> for extras. The first JSON line discloses reach. --read-only exposes only Claude Read/Grep/Glob and drops all MCP servers; no bypass in agent run. Pi requires explicit --ext paths or named installed packages and has no purpose tool scoping. --conversation resumes a nonempty POV transcript. Pinned Thread launches append a snapshot. See README 'agent run' for reach, permission, and trust details.",
    usage: USAGE,
    examples: [
      "ideaspaces agent list --map home.map.md",
      "ideaspaces agent list --map home.map.md --json",
      "ideaspaces agent runs",
      "ideaspaces agent runs --parent <id> --json",
      "ideaspaces agent runs --agent scout --limit 10",
      "ideaspaces agent capabilities --json  # machine-readable run guarantees for launchers",
      "ideaspaces agent run agents/scout --message 'Check findings' --runtime claude --model sonnet --read-only --claude-effort high",
      "ideaspaces agent run agents/scout --message 'Check findings' --runtime claude --reach /path/to/repo --model sonnet",
      "ideaspaces agent run agents/scout --message 'Continue' --runtime pi --ext /path/pi-is-space/src/index.ts,/path/pi-local-context/src/index.ts --pi-trust saved --pi-thinking high",
      "ideaspaces agent run agents/scout --message 'Check findings' --runtime pi --ext pi-is-space,pi-local-context  # only if both @ideaspaces/ packages are installed in Pi",
      "ideaspaces agent run agents/scout --message 'Resume turn' --conversation <existing-id>",
      "ideaspaces agent run agents/scout --thread _threads/decision --thread-map handoff.map.md --thread-member 0 --message 'Continue'",
      "ideaspaces agent run agents/scout --thread x_0123456789abcdef01234567 --message 'Draft a reply'  # private; does not post",
      "ideaspaces agent run n_0935a5df1f883eeb60bcdfbb --message 'Hello from root id' --runtime claude",
    ],
    async run(args, flags, global: GlobalFlags) {
      const output = createOutput(global);
      const [sub, ...rest] = args;
      switch (sub) {
        case "run":
          return cmdRun(rest, flags, local, output, global.json);
        case "runs":
          return cmdRuns(flags, output);
        case "list":
          return cmdList(flags, global, output);
        case "capabilities": {
          const caps = agentRunCapabilities();
          output.result(caps, formatAgentRunCapabilities(caps));
          return 0;
        }
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
