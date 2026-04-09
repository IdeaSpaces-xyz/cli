import type { GlobalFlags } from "./types.js";

export interface Output {
  /** Print data to stdout. In --json mode, serializes to JSON. */
  result(data: unknown, humanText: string): void;
  /** Print info to stderr. Suppressed by --quiet. */
  log(text: string): void;
  /** Print progress to stderr. Suppressed by --quiet and --json. */
  progress(text: string): void;
  /** Print error to stderr. Always shown. */
  error(text: string): void;
}

export function createOutput(flags: GlobalFlags): Output {
  return {
    result(data: unknown, humanText: string) {
      if (flags.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } else {
        process.stdout.write(humanText + "\n");
      }
    },
    log(text: string) {
      if (!flags.quiet) {
        process.stderr.write(text + "\n");
      }
    },
    progress(text: string) {
      if (!flags.quiet && !flags.json) {
        process.stderr.write(text + "\n");
      }
    },
    error(text: string) {
      process.stderr.write(text + "\n");
    },
  };
}
