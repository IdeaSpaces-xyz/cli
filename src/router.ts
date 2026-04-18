import type { CommandDef, GlobalFlags } from "./types.js";

// Top-level commands
import { loginCommand } from "./commands/login.js";
import { navigateCommand } from "./commands/navigate.js";
import { searchCommand } from "./commands/search.js";
import { readCommand } from "./commands/read.js";
import { writeCommand } from "./commands/write.js";
import { awarenessCommand } from "./commands/awareness.js";
import { syncCommand } from "./commands/sync.js";
import { credentialCommand } from "./commands/credential.js";
import { cloneCommand } from "./commands/clone.js";

// Power commands
import { grepCommand } from "./commands/power/grep.js";
import { gitCommand } from "./commands/power/git.js";
import { outlineCommand } from "./commands/power/outline.js";
import { findCommand } from "./commands/power/find.js";
import { moveCommand } from "./commands/power/move.js";
import { deleteCommand } from "./commands/power/delete.js";
import { tagsCommand } from "./commands/power/tags.js";
import { metadataCommand } from "./commands/power/metadata.js";
import { reposCommand } from "./commands/power/repos.js";
import { statusCommand } from "./commands/power/status.js";
import { logoutCommand } from "./commands/power/logout.js";
import { connectCommand } from "./commands/power/connect.js";
import { createCommand } from "./commands/power/create.js";
import { reindexCommand } from "./commands/power/reindex.js";
import { repoCommand } from "./commands/power/repo.js";

const topLevel: CommandDef[] = [
  loginCommand,
  navigateCommand,
  searchCommand,
  readCommand,
  writeCommand,
  awarenessCommand,
  syncCommand,
  cloneCommand,
  credentialCommand,
];

const power: CommandDef[] = [
  grepCommand,
  gitCommand,
  outlineCommand,
  findCommand,
  moveCommand,
  deleteCommand,
  tagsCommand,
  metadataCommand,
  reposCommand,
  statusCommand,
  logoutCommand,
  connectCommand,
  createCommand,
  reindexCommand,
  repoCommand,
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
  lines.push("", "  power          Advanced tools (grep, git, outline, find, move, delete, tags, metadata, connect, create, reindex, repo, ...)");
  lines.push("", "Global flags:");
  lines.push("  --json         Structured JSON output to stdout");
  lines.push("  --repo <slug>  Override space for this command");
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
