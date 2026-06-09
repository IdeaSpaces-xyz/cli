import type { CommandDef } from "./types.js";

// Top-level commands
import { createCommand } from "./commands/create.js";
import { loginCommand } from "./commands/login.js";
import { publishCommand } from "./commands/publish.js";
import { writeCommand } from "./commands/write.js";
import { commitCommand } from "./commands/commit.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { skillsCommand } from "./commands/skills.js";
import { credentialCommand } from "./commands/credential.js";
import { whoamiCommand } from "./commands/whoami.js";
import { reposCommand } from "./commands/repos.js";
import { cloneCommand } from "./commands/clone.js";
import { clonesCommand } from "./commands/clones.js";
import { conversationsCommand } from "./commands/conversations.js";

// Power commands
import { logoutCommand } from "./commands/power/logout.js";

const topLevel: CommandDef[] = [
  createCommand,
  loginCommand,
  whoamiCommand,
  reposCommand,
  cloneCommand,
  clonesCommand,
  conversationsCommand,
  publishCommand,
  writeCommand,
  commitCommand,
  statusCommand,
  syncCommand,
  skillsCommand,
  credentialCommand,
];

const power: CommandDef[] = [
  logoutCommand,
];

export function findCommand_(name: string): CommandDef | undefined {
  return topLevel.find((c) => c.name === name) ?? power.find((c) => c.name === name);
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
  lines.push("  --json         Structured JSON output to stdout");
  lines.push("  --quiet        Suppress non-essential output");
  lines.push("  --yes          Skip confirmation prompts");
  lines.push("  --help         Show help");
  lines.push("", "Run: ideaspaces <command> --help for command-specific help.");
  process.stderr.write(lines.join("\n") + "\n");
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
  process.stderr.write(lines.join("\n") + "\n");
}
