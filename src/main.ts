import { findCommand_, printHelp, printPowerHelp } from "./router.js";
import { handleError } from "./errors.js";
import { createOutput } from "./output.js";
import { parseArgs } from "./argv.js";

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
