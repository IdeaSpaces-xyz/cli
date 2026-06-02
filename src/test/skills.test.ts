import { describe, it, expect } from "vitest";
import { skillsCommand } from "../commands/skills.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

async function capture(args: string[]) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => { out += s; return true; };
  let exit: number;
  try { exit = await skillsCommand.run(args, {}, G); }
  finally { (process.stdout as any).write = orig; }
  return { exit, out };
}

describe("ideaspaces skills", () => {
  it("lists the catalog as JSON", async () => {
    const { exit, out } = await capture([]);
    expect(exit).toBe(0);
    const skills = JSON.parse(out);
    expect(skills.length).toBe(8);
    expect(skills.every((s: any) => s.name && "description" in s)).toBe(true);
  });

  it("prints one skill's content", async () => {
    const { exit, out } = await capture(["awareness"]);
    expect(exit).toBe(0);
    const skill = JSON.parse(out);
    expect(skill.name).toBe("awareness");
    expect(skill.content).toContain("# Awareness");
  });

  it("exits 1 for an unknown skill", async () => {
    expect((await capture(["nope"])).exit).toBe(1);
  });
});
