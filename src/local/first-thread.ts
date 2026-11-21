/**
 * What a place's first Thread opens with: one plain line about what the place is for, and whether
 * Git can commit what is written there. `threads new` uses both; see its help.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@ideaspaces/protocol";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";

/** The longest line the opening post takes, in characters. */
export const LINE_LIMIT = 280;

/** A scaffold's summary that asks rather than says, like "What it is for is not written yet. A prompt — …". */
const PROMPT = /(?:^|[^\p{L}\p{N}])A prompt\b/u;

/**
 * A summary's first sentence as one plain line, at most LINE_LIMIT characters, cut at a word and ended
 * with "…" when longer. A full stop after a digit ("the 2. edition") doesn't end the sentence.
 * Undefined for a summary that is empty or a prompt.
 */
export function plainLine(summary: unknown): string | undefined {
  if (typeof summary !== "string") return undefined;
  const text = summary.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text || PROMPT.test(text)) return undefined;
  const end = /(?<=[^\p{N}\s][.!?])\s+(?=\p{Lu})/u.exec(text);
  const sentence = end ? text.slice(0, end.index) : text;
  if ([...sentence].length <= LINE_LIMIT) return sentence;
  const cut = [...sentence].slice(0, LINE_LIMIT - 1).join("");
  const word = cut.replace(/\s+\S*$/u, "");
  return `${(word.length >= LINE_LIMIT / 2 ? word : cut).replace(/[\s,;:—–-]+$/u, "")}…`;
}

function summaryOf(agreement: string): unknown {
  try { return (parseFrontmatter(readFileSync(agreement, "utf8")) as Record<string, unknown> | null)?.summary; } catch { return undefined; }
}

function isAgent(agreement: string): boolean {
  try { return String((parseFrontmatter(readFileSync(agreement, "utf8")) as Record<string, unknown> | null)?.agreement ?? "").startsWith("agent:"); } catch { return false; }
}

/**
 * What the place is for, in one line, for its first Thread: the summary of the Agreement of the folder
 * that holds `_threads/`, or, when that is a scaffold's prompt, the first firefly's in its `agents/`
 * folder (by folder name) whose summary says something. Undefined when neither says anything.
 */
export function placeLine(place: string): { line: string; source: "agreement" | "firefly"; from: string } | undefined {
  const own = join(place, "_agent", "agreement.md");
  const ownLine = existsSync(own) ? plainLine(summaryOf(own)) : undefined;
  if (ownLine) return { line: ownLine, source: "agreement", from: own };
  const agents = join(place, "agents");
  let names: string[] = [];
  try { names = readdirSync(agents, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return undefined; }
  for (const name of names) {
    const agreement = join(agents, name, "_agent", "agreement.md");
    if (!existsSync(agreement) || !isAgent(agreement)) continue;
    const line = plainLine(summaryOf(agreement));
    if (line) return { line, source: "firefly", from: agreement };
  }
  return undefined;
}

/**
 * Why Git can't commit posts written in this folder, in words a person acts on, or undefined when it
 * can: the folder is in no repository, or the repository's Git has no name or email.
 */
export function commitBlocker(dir: string): string | undefined {
  const git = (...args: string[]) => spawnSync(gitBinary(), args, { cwd: dir, env: sanitizedGitEnvironment(), encoding: "utf8" });
  if (git("rev-parse", "--show-toplevel").status !== 0) {
    return "This folder is in no Git repository, so its posts are written but not committed. Run git init here to keep their history.";
  }
  const missing = ["user.name", "user.email"].filter((key) => !git("config", "--get", key).stdout.trim());
  if (!missing.length) return undefined;
  return `This repository's Git has no ${missing.map((key) => key === "user.name" ? "name" : "email").join(" and ")}, so its posts are written but not committed. ` +
    "Set them here: git config user.name \"Your Name\" and git config user.email you@example.com.";
}
