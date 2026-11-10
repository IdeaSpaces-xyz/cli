import type { CommandDef } from "./types.js";

// Top-level commands
import { doctorCommand } from "./commands/doctor.js";
import { createCommand } from "./commands/create.js";
import { loginCommand } from "./commands/login.js";
import { publishCommand } from "./commands/publish.js";
import { writeCommand } from "./commands/write.js";
import { commitCommand } from "./commands/commit.js";
import { changeCommand } from "./commands/change.js";
import { lookCommand } from "./commands/look.js";
import { navigateCommand } from "./commands/navigate.js";
import { mapCommand } from "./commands/map.js";
import { inspectCommand } from "./commands/inspect.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { pushCommand } from "./commands/push.js";
import { pullCommand } from "./commands/pull.js";
import { skillsCommand } from "./commands/skills.js";
import { credentialCommand } from "./commands/credential.js";
import { whoamiCommand } from "./commands/whoami.js";
import { reposCommand } from "./commands/repos.js";
import { vaultsCommand } from "./commands/vaults.js";
import { catalogCommand } from "./commands/catalog.js";
import { cloneCommand } from "./commands/clone.js";
import { getCommand } from "./commands/get.js";
import { integrateCommand } from "./commands/integrate.js";
import { clonesCommand } from "./commands/clones.js";
import { forkCommand } from "./commands/fork.js";
import { updateCommand } from "./commands/update.js";
import { updateCheckCommand, upgradeCommand } from "./commands/upgrade.js";
import { linkCommand } from "./commands/link.js";
import { forgetCommand } from "./commands/forget.js";
import { makeConversationsCommand } from "./commands/conversations.js";
import { makeConversationCommand } from "./commands/conversation.js";
import { makeAgentCommand } from "./commands/agent.js";
import { agentsCommand } from "./commands/agents.js";
import { nodeCommand } from "./commands/node.js";
import { searchCommand } from "./commands/search.js";
import { lsCommand } from "./commands/ls.js";
import { timesCommand } from "./commands/times.js";
import { shareCommand } from "./commands/share.js";
import { requestCommand } from "./commands/request.js";
import { spacesCommand } from "./commands/spaces.js";
import { threadsCommand } from "./commands/threads.js";
import { followCommand, unfollowCommand } from "./commands/follow.js";

// Power commands
import { logoutCommand } from "./commands/power/logout.js";

// The Pi connector (src/pi/) — this composition root is the ONLY place that
// wires it into the core: it registers the Pi-runtime commands and injects the
// local-conversation handlers. Core commands never import src/pi/ (enforced by
// src/test/pi-boundary.test.ts).
import {
  piStatusCommand,
  piModelsCommand,
  piLoginCommand,
  piLogoutCommand,
  localConversationOps as piConversationOps,
} from "./pi/index.js";
// The Claude Code connector (src/claude/) — the second local runtime, picked
// by `--runtime=claude`. Same wall: only this file wires it in.
import { claudeConversationOps, claudeStatusCommand, claudeModelsCommand } from "./claude/index.js";
import { composeLocalConversationOps } from "./local/runtime.js";

const localConversationOps = composeLocalConversationOps({ pi: piConversationOps, claude: claudeConversationOps });
const conversationCommand = makeConversationCommand(localConversationOps);
const conversationsCommand = makeConversationsCommand(localConversationOps);
const agentCommand = makeAgentCommand(localConversationOps);

const topLevel: CommandDef[] = [
  doctorCommand,
  createCommand,
  loginCommand,
  whoamiCommand,
  reposCommand,
  vaultsCommand,
  catalogCommand,
  piStatusCommand,
  piModelsCommand,
  piLoginCommand,
  piLogoutCommand,
  claudeStatusCommand,
  claudeModelsCommand,
  getCommand,
  integrateCommand,
  cloneCommand,
  forkCommand,
  updateCommand,
  upgradeCommand,
  clonesCommand,
  linkCommand,
  forgetCommand,
  conversationsCommand,
  conversationCommand,
  agentCommand,
  agentsCommand,
  nodeCommand,
  searchCommand,
  lsCommand,
  publishCommand,
  writeCommand,
  commitCommand,
  changeCommand,
  navigateCommand,
  lookCommand,
  mapCommand,
  inspectCommand,
  statusCommand,
  timesCommand,
  shareCommand,
  requestCommand,
  spacesCommand,
  threadsCommand,
  pullCommand,
  pushCommand,
  syncCommand,
  skillsCommand,
  credentialCommand,
];

const power: CommandDef[] = [
  logoutCommand,
];

// Hidden compatibility refusals, not active subscription capabilities.
const retiredCommands = [followCommand, unfollowCommand];
// Internal: never listed, only started by the CLI itself.
const hiddenCommands = [updateCheckCommand];

export function findCommand_(name: string): CommandDef | undefined {
  return topLevel.find((c) => c.name === name) ?? power.find((c) => c.name === name)
    ?? retiredCommands.find((c) => c.name === name)
    ?? hiddenCommands.find((c) => c.name === name);
}

export function printHelp(): void {
  const lines = [
    "Usage: ideaspaces <command> [options]",
    "",
    "Commands:",
  ];
  for (const cmd of topLevel) {
    lines.push(`  ${cmd.name.padEnd(14)} ${cmd.description}`);
  }
  lines.push("", "  power          Advanced tools (logout, ...)");
  lines.push("", "Global flags:");
  lines.push("  --git-bin <path> Explicit git executable path (or set IDEASPACES_GIT_BIN)");
  lines.push("  --json           Structured JSON output to stdout");
  lines.push("  --quiet          Suppress non-essential output");
  lines.push("  --yes            Apply the plan (create, publish, share visibility)");
  lines.push("  --help           Show help");
  lines.push("  --version        Print this CLI's version");
  lines.push("  --token-fd <n>   Host-run only (IDEASPACES_AUTH=host): read the app's {api_url, access_token} once from inherited fd n");
  lines.push("", "Run: ideaspaces <command> --help for command-specific help.");
  process.stdout.write(lines.join("\n") + "\n");
}

/** Help is metadata, never a command invocation. Unknown verbs must not look like valid help. */
export function commandHelp(cmd: CommandDef, args: string[]): string | undefined {
  const verb = args[0];
  let usage = cmd.usage;
  if (verb && cmd.subcommands) {
    if (Object.hasOwn(cmd.subcommands, verb)) usage = cmd.subcommands[verb];
    else if (!cmd.helpArgument?.(verb)) return undefined;
  }
  const lines = [`Usage: ${usage}`, "", cmd.description];
  if (cmd.help) lines.push("", cmd.help);
  const examples = verb && cmd.subcommands && Object.hasOwn(cmd.subcommands, verb)
    ? cmd.examples?.filter((line) => line.startsWith(`ideaspaces ${cmd.name} ${verb} `) || line.startsWith(`ideaspaces ${cmd.name} ${verb} #`))
    : cmd.examples;
  if (examples?.length) lines.push("", "Examples:", ...examples.map((line) => `  ${line}`));
  return lines.join("\n") + "\n";
}

export function printPowerHelp(): void {
  const lines = [
    "Usage: ideaspaces power <command> [options]",
    "",
    "Power tools:",
  ];
  for (const cmd of power) {
    lines.push(`  ${cmd.name.padEnd(14)} ${cmd.description}`);
  }
  lines.push("", "Run: ideaspaces power <command> --help for details.");
  process.stdout.write(lines.join("\n") + "\n");
}
