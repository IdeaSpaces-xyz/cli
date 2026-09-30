import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeLaunchSets, inspectLaunchSet, launchSetStorePath, readLaunchSets, selectApprovedLaunch } from "../local/child-launch-approval.js";
import { makeAgentCommand } from "../commands/agent.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import type { GlobalFlags } from "../types.js";

const global: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
let root: string;
let home: string | undefined;
let ext: string;
let skills: string;
const local: LocalConversationOps = { send: async () => 0, createNew: () => 0, get: () => 0, list: () => 0 };

beforeEach(() => {
  home = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "child-approval-"));
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "src"), { recursive: true });
  skills = join(pkg, "skills");
  mkdirSync(skills);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@test/connector", version: "1.2.3" }));
  ext = join(pkg, "src", "index.ts");
  writeFileSync(ext, "export default () => {};\n");
  writeFileSync(join(skills, "SKILL.md"), "# Reviewed\n");
});
afterEach(() => {
  if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  rmSync(root, { recursive: true, force: true });
});

function approve(name = "core"): void {
  const set = inspectLaunchSet([ext], [skills]);
  changeLaunchSets((record) => { record.sets[name] = set; });
}

describe("per-user child execution approval", () => {
  it("has no default and refuses missing names or unapproved raw paths", () => {
    expect(readLaunchSets().sets).toEqual({});
    expect(() => selectApprovedLaunch(undefined, [ext], [skills])).toThrow(/do not match any approved/);
    expect(() => selectApprovedLaunch("core", [], [])).toThrow(/unknown or revoked/);
  });

  it("binds a named set to canonical paths, package identity and skill bytes; dedupes aliases", () => {
    const alias = join(root, "alias.ts");
    symlinkSync(ext, alias);
    const set = inspectLaunchSet([ext, alias], [skills, skills]);
    expect(set.extensions).toEqual([realpathSync(ext)]);
    expect(set.skills).toEqual([realpathSync(skills)]);
    expect(set.packages).toMatchObject([{ name: "@test/connector", version: "1.2.3", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    approve();
    expect(selectApprovedLaunch("core", [], []).set).toEqual(set);
    expect(selectApprovedLaunch(undefined, [realpathSync(ext)], [realpathSync(skills)]).name).toBe("core");
    expect(() => selectApprovedLaunch("core", [ext], [])).toThrow(/cannot be combined/);
    expect(() => selectApprovedLaunch(undefined, [ext], [])).toThrow(/do not match/);
  });

  it("invalidates on changed extension, skill, package identity or a dependency byte", () => {
    for (const path of [ext, join(skills, "SKILL.md"), join(root, "package", "package.json"), join(root, "package", "src", "helper.ts")]) {
      if (path.endsWith("helper.ts")) writeFileSync(path, "export const n = 1;\n");
      approve();
      const before = readFileSync(path, "utf8");
      writeFileSync(path, path.endsWith("package.json") ? JSON.stringify({ name: "@test/connector", version: "1.2.4" }) : `${before}\nchanged`);
      expect(() => selectApprovedLaunch("core", [], [])).toThrow(/changed/);
      writeFileSync(path, before);
    }
  });

  it("refuses missing and escaping resources or corrupt or insecure records", () => {
    approve();
    rmSync(ext);
    expect(() => selectApprovedLaunch("core", [], [])).toThrow(/not found/);
    writeFileSync(ext, "export default () => {};\n");
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "export default () => {};\n");
    const link = join(skills, "escape.ts");
    symlinkSync(outside, link);
    expect(() => selectApprovedLaunch("core", [], [])).toThrow(/symlink escapes/);
    rmSync(link);
    writeFileSync(launchSetStorePath(), "{");
    expect(() => selectApprovedLaunch("core", [], [])).toThrow(/corrupt approval record/);
    if (process.platform !== "win32") {
      chmodSync(launchSetStorePath(), 0o666);
      expect(() => readLaunchSets()).toThrow(/unsafe approval record/);
    }
  });

  it("agent run passes only a verified named set, and refuses changed skills before send", async () => {
    approve();
    const pov = join(root, "pov");
    mkdirSync(join(pov, "_agent"), { recursive: true });
    writeFileSync(join(pov, "_agent", "agreement.md"), "---\nname: Probe\n---\n# Probe\n");
    const send = vi.fn(async () => 0);
    const command = makeAgentCommand({ ...local, send });
    expect(await command.run(["run", pov], { runtime: "pi", "launch-set": "core", message: "hi" }, global)).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ context: realpathSync(pov) }), expect.anything(),
      expect.objectContaining({ approvalName: "core", extensionPaths: [realpathSync(ext)], skillPaths: [realpathSync(skills)] }));
    send.mockClear();
    expect(await command.run(["run", pov], { runtime: "pi", ext, skill: skills, message: "hi" }, global)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1); // explicit raw paths are not a bypass
    send.mockClear();
    writeFileSync(join(skills, "SKILL.md"), "# Changed after approval\n");
    expect(await command.run(["run", pov], { runtime: "pi", "launch-set": "core", message: "hi" }, global)).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(await command.run(["run", pov], { runtime: "claude", "launch-set": "core", message: "hi" }, global)).toBe(1);
  });

  it("approves and revokes only after explicit terminal review; --yes cannot grant", async () => {
    const confirmation = vi.fn(async () => true); // test stand-in for a person's TTY response
    const command = makeAgentCommand(local, confirmation);
    expect(await command.run(["launch-set", "approve", "core"], { ext, skill: skills }, { ...global, yes: true })).toBe(1);
    expect(confirmation).not.toHaveBeenCalled();
    expect(readLaunchSets().sets).toEqual({});
    expect(await command.run(["launch-set", "approve", "core"], { ext, skill: skills }, global)).toBe(0);
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("@test/connector@1.2.3"), "core");
    expect(readLaunchSets().sets.core).toBeDefined();
    expect(await command.run(["launch-set", "revoke", "core"], {}, global)).toBe(0);
    expect(readLaunchSets().sets.core).toBeUndefined();
    expect(await makeAgentCommand(local).run(["launch-set", "approve", "core"], { ext }, global)).toBe(1);
    expect(readLaunchSets().sets.core).toBeUndefined();
  });
});
