import { findCommand_, printHelp, printPowerHelp } from "./router.js";
import { handleError } from "./errors.js";
import { createOutput } from "./output.js";
import { parseArgs } from "./argv.js";

// ─── Main ──────────────────────────────────────────────────────────

/**
 * Flush stdout + stderr, then exit. `process.stdout.write()` is non-blocking to
 * a pipe: anything past the OS pipe buffer (~64 KB) is queued in the stream, and
 * `process.exit()` terminates without draining it — truncating large output
 * (e.g. a big `conversation get`), so a reader sees invalid JSON. The empty
 * write's callback fires once all prior writes have reached the OS; a timeout
 * guards a runtime that never fires it.
 */
function flushAndExit(code: number): void {
  let pending = 2;
  const onFlushed = (): void => {
    if (--pending === 0) process.exit(code);
  };
  setTimeout(() => process.exit(code), 3000).unref();
  process.stdout.write("", onFlushed);
  process.stderr.write("", onFlushed);
}

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
  flushAndExit(exitCode);
} catch (err) {
  const output = createOutput(global);
  const exitCode = handleError(err, output);
  flushAndExit(exitCode);
}
