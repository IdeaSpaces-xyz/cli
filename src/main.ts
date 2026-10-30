import { writeSync } from "node:fs";
import { findCommand_, printHelp, printPowerHelp } from "./router.js";
import { handleError } from "./errors.js";
import { createOutput } from "./output.js";
import { STATUS_SECTIONS } from "./commands/status.js";
import { parseArgs } from "./argv.js";

// ─── Main ──────────────────────────────────────────────────────────

/**
 * Replace a stream's `write` with a synchronous fd write (partial-write-safe,
 * retrying on EAGAIN). `process.stdout.write()` is non-blocking to a pipe:
 * output past the OS pipe buffer (~64 KB) can be queued in the stream. Forced
 * exits previously truncated large output (e.g. a 100 KB `conversation get`) at
 * 64 KB, so the desktop read invalid JSON. Keep this independent of runtime
 * exit/drain behaviour, including the bun-compiled sidecar: a synchronous fd
 * write blocks until the bytes reach the OS. Command completion below now lets
 * Node finish its own teardown. Installed in the real entry (never imported by
 * tests), so test stubs of `process.stdout.write` are untouched.
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

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\nRun: ideaspaces --help\n`);
  process.exit(1);
}
const { global, command, args, flags } = parsed;

// Propagate explicit --git-bin to process.env.IDEASPACES_GIT_BIN so all
// downstream git operations, subprocesses, and protocol adapters honor the override.
if (global.gitBin) {
  process.env.IDEASPACES_GIT_BIN = global.gitBin;
}

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

// `status <section>` is the canonical spelling of a CLI-owned section whose
// definition still lives under its legacy name; `--help` should reach it.
if (command === "status" && args[0] !== undefined && Object.hasOwn(STATUS_SECTIONS, args[0])) {
  resolvedCommand = STATUS_SECTIONS[args[0]].name;
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

// A completed HTTP read can still leave native background work pending. Forcing
// exit here races Node's teardown on Windows (UV_HANDLE_CLOSING after redirects),
// even after the response body and output are complete. Preserve the status and
// let the runtime drain; command-owned resources must be closed by their owners.
try {
  const exitCode = await cmd.run(resolvedArgs, flags, global);
  process.exitCode = exitCode;
} catch (err) {
  const output = createOutput(global);
  const exitCode = handleError(err, output);
  process.exitCode = exitCode;
}
