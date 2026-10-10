import { resolve } from "node:path";
import type { GlobalFlags } from "./types.js";

const BOOLEAN_COMMAND_FLAGS = new Set(["read-only"]);

function parseGitBin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("--git-bin requires a path argument");
  return trimmed.includes("/") || trimmed.includes("\\") ? resolve(trimmed) : trimmed;
}
function setFlag(flags: Record<string, string | boolean>, key: string, value: string): void {
  if (key === "reach") {
    // Only agent run consumes this array; keep paths with commas intact.
    const previous: unknown = flags.reach;
    (flags as Record<string, unknown>).reach = [...(Array.isArray(previous) ? previous : []), value];
  } else {
    flags[key] = value;
  }
}

export interface ParsedArgs {
  global: GlobalFlags;
  command: string | undefined;
  args: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Canonical bool-flag parser. `undefined` → `dflt` (for absent flags);
 * a boolean passes through; a string is false only for the negative tokens.
 * Shared so `--stage=false` / `--rebase=false` parse identically everywhere.
 */
export function parseBool(value: unknown, dflt = true): boolean {
  if (value === undefined) return dflt;
  if (typeof value !== "string") return Boolean(value);
  const v = value.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export function parseArgs(argv: string[]): ParsedArgs {
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
        const value = arg.slice(eqIdx + 1);

        if (key === "json") { global.json = parseBool(value); continue; }
        if (key === "quiet") { global.quiet = parseBool(value); continue; }
        if (key === "yes") { global.yes = parseBool(value); continue; }
        if (key === "help") { global.help = parseBool(value); continue; }
        if (key === "repo") { global.repo = value; continue; }
        if (key === "git-bin") {
          global.gitBin = parseGitBin(value);
          continue;
        }

        setFlag(flags, key, value);
        continue;
      }

      const key = arg.slice(2);
      // This flag has no value on any command. Handle it before positional
      // discovery too (`--read-only agent run …` must not swallow `agent`).
      if (BOOLEAN_COMMAND_FLAGS.has(key)) { flags[key] = true; continue; }
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
      if (key === "git-bin") {
        if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
          throw new Error("--git-bin requires a path argument");
        }
        global.gitBin = parseGitBin(argv[++i]);
        continue;
      }
      // Command-specific flag with value
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        setFlag(flags, key, argv[++i]);
      } else {
        flags[key] = true;
      }
    } else if (!stopFlags && /^-[a-zA-Z]$/.test(arg)) {
      // Single-letter short flag (e.g. `-m`). Takes the next token as its
      // value when present, else boolean. Maps to flags[<letter>]; commands
      // alias as needed (e.g. commit reads `m` || `message`).
      // Limitation: a value starting with `-` is read as a separate flag, so
      // for messages/values beginning with a hyphen use the long form
      // (`--message "-1"`), which only excludes `--`-prefixed tokens.
      const key = arg.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0];
  const args = positional.slice(1);
  return { global, command, args, flags };
}
