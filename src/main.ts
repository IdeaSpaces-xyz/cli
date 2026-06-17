import { writeSync } from "node:fs";
import { findCommand_, printHelp, printPowerHelp } from "./router.js";
import { handleError } from "./errors.js";
import { createOutput } from "./output.js";
import { parseArgs } from "./argv.js";

// ─── Main ──────────────────────────────────────────────────────────

/**
 * Replace a stream's `write` with a synchronous fd write (partial-write-safe,
 * retrying on EAGAIN). `process.stdout.write()` is non-blocking to a pipe:
 * output past the OS pipe buffer (~64 KB) is queued in the stream, and the CLI
 * calls `process.exit()` right after a command — terminating before the queued
 * tail drains. That truncated large output (e.g. a 100 KB `conversation get`) at
 * 64 KB, so the desktop read invalid JSON. The Node "drain before exit" trick
 * doesn't help the bun-compiled sidecar (bun's `process.exit()` doesn't await
 * it); a synchronous fd write blocks until the bytes reach the OS, in any
 * runtime. Installed here, in the real entry (never imported by tests), so test
 * stubs of `process.stdout.write` are untouched.
 */
function installSyncWriter(stream: NodeJS.WriteStream, fd: number): void {
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    let offset = 0;
    while (offset < buf.length) {
      try {
        offset += writeSync(fd, buf, offset, buf.length - offset);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw err;
      }
    }
    const cb = rest.find((a) => typeof a === "function") as
      | ((e?: Error | null) => void)
      | undefined;
    cb?.();
    return true;
  }) as typeof stream.write;
}
installSyncWriter(process.stdout, 1);
installSyncWriter(process.stderr, 2);

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
