import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkillPointers, GENERATED_MARKER } from "../skills-sync.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-skills-sync-"));
  await fs.mkdir(join(tmp, "_agent"), { recursive: true });
  await fs.writeFile(join(tmp, "_agent", "foundation.md"), "# Foundation", "utf-8");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeSkill(rel: string, frontmatter: string): Promise<void> {
  const abs = join(tmp, rel);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, `---\n${frontmatter}\n---\n# Body\n`, "utf-8");
}

describe("skills sync", () => {
  it("returns null outside an ideaspace", async () => {
    const bare = await mkdtemp(join(tmpdir(), "is-cli-bare-"));
    try {
      expect(await syncSkillPointers(bare)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("mirrors pointers at each level and copies the portable fields", async () => {
    await writeSkill(
      "_agent/skills/meeting-notes.md",
      'name: meeting-notes\ndescription: Turn a transcript into a record.\nallowed-tools: "Read, Bash"',
    );
    await writeSkill(
      "clients/acme/_agent/skills/acme-report/SKILL.md",
      "name: acme-report\ndescription: Acme quarterly report shape.",
    );

    const report = await syncSkillPointers(tmp);

    expect(report?.created.sort()).toEqual([
      join(".claude", "skills", "meeting-notes", "SKILL.md"),
      join("clients", "acme", ".claude", "skills", "acme-report", "SKILL.md"),
    ]);
    const rootPointer = await fs.readFile(
      join(tmp, ".claude", "skills", "meeting-notes", "SKILL.md"),
      "utf-8",
    );
    expect(rootPointer).toContain("description: Turn a transcript into a record.");
    expect(rootPointer).toContain("allowed-tools: Read, Bash");
    expect(rootPointer).toContain(GENERATED_MARKER);
    // Pointer links back to the canonical file, relative to the pointer.
    expect(rootPointer).toContain("../../../_agent/skills/meeting-notes.md");

    // Second run is a no-op.
    const again = await syncSkillPointers(tmp);
    expect(again?.created).toEqual([]);
    expect(again?.updated).toEqual([]);
    expect(again?.unchanged).toBe(2);
  });

  it("falls back to summary as the pointer description", async () => {
    await writeSkill("_agent/skills/review.md", "name: Review\nsummary: Verify before claiming done.");
    await syncSkillPointers(tmp);
    const pointer = await fs.readFile(
      join(tmp, ".claude", "skills", "review", "SKILL.md"),
      "utf-8",
    );
    expect(pointer).toContain("description: Verify before claiming done.");
  });

  it("never touches user-authored .claude skills and removes stale generated ones", async () => {
    await writeSkill("_agent/skills/current.md", "name: current\ndescription: Still here.");
    // User-authored skill colliding with nothing — and one colliding by name.
    const userDir = join(tmp, ".claude", "skills", "current");
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(join(userDir, "SKILL.md"), "---\nname: current\n---\nHand-written.", "utf-8");
    // Stale generated pointer for a removed skill.
    const staleDir = join(tmp, ".claude", "skills", "gone");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(
      join(staleDir, "SKILL.md"),
      `---\nname: gone\n---\n<!-- ${GENERATED_MARKER} -->\nold pointer`,
      "utf-8",
    );

    const report = await syncSkillPointers(tmp);

    expect(report?.skipped).toEqual([join(".claude", "skills", "current", "SKILL.md")]);
    expect(report?.removed).toEqual([join(".claude", "skills", "gone", "SKILL.md")]);
    // The hand-written file survives byte-for-byte; the stale pointer is gone.
    expect(await fs.readFile(join(userDir, "SKILL.md"), "utf-8")).toContain("Hand-written.");
    expect(existsSync(join(staleDir, "SKILL.md"))).toBe(false);
  });

  it("--check reports drift without writing and leaves the tree untouched", async () => {
    await writeSkill("_agent/skills/one.md", "name: one\ndescription: First.");
    const report = await syncSkillPointers(tmp, { check: true });
    expect(report?.created).toEqual([join(".claude", "skills", "one", "SKILL.md")]);
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
  });

  it("does not descend into nested spaces", async () => {
    await writeSkill("nested/_agent/skills/inner.md", "name: inner\ndescription: Not ours.");
    await fs.writeFile(join(tmp, "nested", "_agent", "foundation.md"), "# Own space", "utf-8");
    const report = await syncSkillPointers(tmp);
    expect(report?.created).toEqual([]);
    expect(existsSync(join(tmp, "nested", ".claude"))).toBe(false);
  });
});
