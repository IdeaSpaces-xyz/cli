/**
 * Generate committed `.claude/skills/` pointers from canonical `_agent/skills/`.
 *
 * Placement is the model (SKILLS-2): pointers mirror the canonical skill's
 * level 1:1. Root-level skills are the persona's abilities — Claude Code loads
 * project skills at session start; branch-level skills are contextual — nested
 * `.claude/skills/` load when the agent first touches that directory. No
 * flattening to root, so a session never carries skills its position hasn't
 * earned.
 *
 * The pointer's frontmatter copies the Agent Skills spec's portable fields
 * (`description`, `allowed-tools`, `license`, `compatibility`, `metadata`) so
 * triggering and tool enforcement work natively; the body is a marked pointer
 * at the canonical file. Sync only ever rewrites or removes files carrying the
 * marker — a user-authored `.claude/skills/` entry is never touched.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { stringify } from "yaml";
import {
  composeContractAlongPath,
  discoverSkillEntries,
  parseFrontmatter,
} from "@ideaspaces/protocol";

export const GENERATED_MARKER = "ideaspaces:generated skill pointer";

const MARKER_LINE = `<!-- ${GENERATED_MARKER} — edit the canonical skill, then re-run \`ideaspaces skills sync\` -->`;

/** Agent Skills spec portable fields copied into a pointer, beside `name`. */
const PORTABLE_FIELDS = ["description", "license", "compatibility", "metadata", "allowed-tools"] as const;

export interface SkillsSyncReport {
  spaceRoot: string;
  created: string[];
  updated: string[];
  removed: string[];
  /** Target paths occupied by non-generated files — never touched. */
  skipped: string[];
  unchanged: number;
  /** Levels whose `_agent/` is gitignored while pointers would be committed. */
  privateAgentLevels: string[];
}

/** Paths in the report are relative to the space root. */
export async function syncSkillPointers(
  position: string,
  opts: { check?: boolean } = {},
): Promise<SkillsSyncReport | null> {
  const composed = await composeContractAlongPath(position);
  if (!composed.spaceRoot) return null;
  const root = composed.spaceRoot;
  const check = opts.check === true;

  const report: SkillsSyncReport = {
    spaceRoot: root,
    created: [],
    updated: [],
    removed: [],
    skipped: [],
    unchanged: 0,
    privateAgentLevels: [],
  };

  for (const level of await collectSkillLevels(root)) {
    const entries = await discoverSkillEntries([level]);
    const wanted = new Set(entries.map((e) => e.name));
    const pointerRoot = join(level, ".claude", "skills");

    for (const entry of entries) {
      const target = join(pointerRoot, entry.name, "SKILL.md");
      const desired = await renderPointer(entry.name, entry.path, dirname(target));
      const rel = relative(root, target);

      if (existsSync(target)) {
        const existing = await fs.readFile(target, "utf-8");
        if (!existing.includes(GENERATED_MARKER)) {
          report.skipped.push(rel);
          continue;
        }
        if (existing === desired) {
          report.unchanged += 1;
          continue;
        }
        report.updated.push(rel);
        if (!check) await fs.writeFile(target, desired, "utf-8");
      } else {
        report.created.push(rel);
        if (!check) {
          await fs.mkdir(dirname(target), { recursive: true });
          await fs.writeFile(target, desired, "utf-8");
        }
      }
    }

    // Stale pointers: marker-carrying entries whose canonical skill is gone.
    let pointerDirs: string[] = [];
    try {
      pointerDirs = (await fs.readdir(pointerRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // no pointer dir at this level
    }
    for (const name of pointerDirs) {
      if (wanted.has(name)) continue;
      const target = join(pointerRoot, name, "SKILL.md");
      let existing: string;
      try {
        existing = await fs.readFile(target, "utf-8");
      } catch {
        continue;
      }
      if (!existing.includes(GENERATED_MARKER)) continue;
      report.removed.push(relative(root, target));
      if (!check) {
        await fs.rm(target);
        await fs.rmdir(join(pointerRoot, name)).catch(() => {});
      }
    }

    if (agentIsGitignored(level)) report.privateAgentLevels.push(relative(root, level) || ".");
  }

  return report;
}

/**
 * Skill-carrying levels of this space: the root plus every descendant with
 * `_agent/skills/`, excluding nested spaces (their own `foundation.md` marks
 * their own contract), dot-dirs, underscore infrastructure, and node_modules.
 */
async function collectSkillLevels(root: string): Promise<string[]> {
  const levels: string[] = [];
  async function walk(dir: string, isRoot: boolean): Promise<void> {
    if (!isRoot && existsSync(join(dir, "_agent", "foundation.md"))) return;
    if (existsSync(join(dir, "_agent", "skills"))) levels.push(dir);
    let dirents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name.startsWith("_") || e.name === "node_modules") continue;
      await walk(join(dir, e.name), false);
    }
  }
  await walk(root, true);
  return levels;
}

async function renderPointer(name: string, canonicalPath: string, pointerDir: string): Promise<string> {
  const content = await fs.readFile(canonicalPath, "utf-8");
  const fm = parseFrontmatter(content) ?? {};
  const pointerFm: Record<string, unknown> = { name };
  for (const field of PORTABLE_FIELDS) {
    if (fm[field] != null) pointerFm[field] = fm[field];
  }
  // Skills authored to the Notes convention carry only `summary` — still a trigger.
  if (pointerFm.description == null && typeof fm.summary === "string") {
    pointerFm.description = fm.summary;
  }
  const rel = relative(pointerDir, canonicalPath);
  return [
    "---",
    stringify(pointerFm).trimEnd(),
    "---",
    "",
    MARKER_LINE,
    "",
    `Generated pointer for **${name}**. The canonical skill lives at`,
    `[${rel}](${rel}) — read that file and follow it as this skill's`,
    "instructions.",
    "",
  ].join("\n");
}

/** True when the level's `_agent/` is gitignored — committed pointers would dangle for cloners. */
function agentIsGitignored(level: string): boolean {
  const r = spawnSync("git", ["-C", level, "check-ignore", "-q", join(level, "_agent", "skills")], {
    encoding: "utf-8",
  });
  return r.status === 0;
}
