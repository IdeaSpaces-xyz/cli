import type { GlobalFlags } from "./types.js";
import { findCommand_, printHelp, printPowerHelp } from "./router.js";
import { handleError } from "./errors.js";
import { createOutput } from "./output.js";

// ─── Parse argv ────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  global: GlobalFlags;
  command: string | undefined;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  const global: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let stopFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      stopFlags = true;
      continue;
    }

    if (!stopFlags && arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        // Global flags are boolean
        if (key === "json") { global.json = true; continue; }
        if (key === "quiet") { global.quiet = true; continue; }
        if (key === "yes") { global.yes = true; continue; }
        if (key === "help") { global.help = true; continue; }
        // Check if next arg is a value
        if (key === "repo" && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          global.repo = argv[++i];
          continue;
        }
        // Command-specific flag with value
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0];
  const args = positional.slice(1);
  return { global, command, args, flags };
}

// ─── Main ──────────────────────────────────────────────────────────

const { global, command, args, flags } = parseArgs(process.argv.slice(2));

if (!command || global.help && !command) {
  printHelp();
  process.exit(0);
}

// Handle "power" namespace
let resolvedCommand = command;
let resolvedArgs = args;

if (command === "power") {
  if (global.help || !args[0]) {
    printPowerHelp();
    process.exit(0);
  }
  resolvedCommand = args[0];
  resolvedArgs = args.slice(1);
}

const cmd = findCommand_(resolvedCommand);
if (!cmd) {
  process.stderr.write(`Unknown command: ${resolvedCommand}\nRun: ideaspaces --help\n`);
  process.exit(1);
}

if (global.help) {
  const lines = [`Usage: ${cmd.usage}`, "", cmd.description];
  if (cmd.examples?.length) {
    lines.push("", "Examples:");
    for (const ex of cmd.examples) lines.push(`  ${ex}`);
  }
  process.stderr.write(lines.join("\n") + "\n");
  process.exit(0);
}

try {
  const exitCode = await cmd.run(resolvedArgs, flags, global);
  process.exit(exitCode);
} catch (err) {
  const output = createOutput(global);
  const exitCode = handleError(err, output);
  process.exit(exitCode);
}
