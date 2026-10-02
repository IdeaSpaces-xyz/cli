import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { lookCommand } from "../commands/look.js";
import { navigateCommand } from "../commands/navigate.js";
import { LAUNCH_MAP_ENV, launchMapEnv, looksLikeMapAddress } from "../local/address-read.js";
import { loadMapOrientation } from "../local/map-orientation.js";
import type { CommandDef, GlobalFlags } from "../types.js";

const ID_NOTES = "n_111111111111111111111111";
const ID_PLANS = "n_222222222222222222222222";
const ID_ABSENT = "n_333333333333333333333333";

const JSON_FLAGS: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_FLAGS: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function repo(dir: string, name: string, id: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  commit(dir, "_agent/agreement.md", `---\nname: Agreement — ${name}\nroot_node_id: ${id}\nsummary: The ${name} space.\n---\n# ${name}\n`);
  return dir;
}

function commit(dir: string, path: string, content: string): string {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, ["add", path]);
  git(dir, ["commit", "-q", "-m", `write ${path}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function note(name: string, summary: string, body = ""): string {
  return `---\nname: ${name}\nsummary: ${summary}\n---\n# ${name}\n${body}`;
}

function writeMap(path: string, roots: object[], members: object[], legend = "A legend.\n"): string {
  const block = (items: object[]) =>
    items.flatMap((item) =>
      Object.entries(item).map(([key, value], index) => `${index ? "      " : "    - "}${key}: ${JSON.stringify(value)}`),
    );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    ["---", "name: Space", "summary: The test Space.", "map:", "  roots:", ...block(roots), "  members:", ...block(members), "---", legend].join("\n"),
  );
  return path;
}

async function run(
  command: CommandDef,
  args: string[],
  flags: Record<string, string | boolean> = {},
  global: GlobalFlags = JSON_FLAGS,
): Promise<{ exit: number; data: any; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await command.run(args, flags, global);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  const text = stdout.join("");
  return { exit, data: global.json && text ? JSON.parse(text) : null, stdout: text, stderr: stderr.join("") };
}

// Every test builds several Git repositories; Windows process startup exceeds the 5s default.
describe("reading a Map member by address", { timeout: 30_000 }, () => {
  let base: string;
  let space: string;
  let notes: string;
  let plans: string;
  let pin: string;
  let elsewhere: string;
  let originalHome: string | undefined;
  let originalMap: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "is-map-address-read-")));
    originalHome = process.env.HOME;
    originalMap = process.env[LAUNCH_MAP_ENV];
    originalCwd = process.cwd();
    // The registry lives under HOME; never touch the real one.
    process.env.HOME = join(base, "user");
    mkdirSync(process.env.HOME);
    delete process.env[LAUNCH_MAP_ENV];

    space = join(base, "space");
    mkdirSync(space);
    // The Space is a repository too; its children are their own, ignored by it.
    git(space, ["init", "-q"]);
    notes = repo(join(space, "knowledge", "notes"), "Notes", ID_NOTES);
    commit(notes, "README.md", note("Notes", "Where notes live."));
    pin = commit(notes, "ideas/first.md", note("First idea", "The pinned wording.", "\n## Why\n\nBecause.\n"));
    commit(notes, "ideas/first.md", note("First idea", "The wording after the pin.", "\n## Why\n\nBecause.\n"));
    plans = repo(join(space, "agents", "planner"), "Planner", ID_PLANS);
    const plansPin = commit(plans, "plans/one.md", note("Plan one", "The first plan."));
    writeMap(
      join(space, "space.map.md"),
      [
        { root_node_id: ID_NOTES, sha: pin },
        { root_node_id: ID_PLANS, sha: plansPin, name: "plans" },
        { root_node_id: ID_ABSENT, sha: "a".repeat(40) },
      ],
      [
        { root: 0, position: "ideas", depth: "children", summary: "Ideas, by the curator." },
        { root: 1, position: "plans/one.md", depth: "surface" },
        { root: 2, position: ".", depth: "summary", summary: "A root nobody here has." },
        { address: "https://example.com/source", depth: "summary", name: "Primary source" },
      ],
    );
    writeMap(
      join(space, "_threads", "t", "_agent", "maps", "sent.md"),
      [{ root_node_id: ID_NOTES, sha: pin }],
      [{ root: 0, position: "ideas/first.md", depth: "summary" }],
    );
    elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    process.chdir(elsewhere);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMap === undefined) delete process.env[LAUNCH_MAP_ENV];
    else process.env[LAUNCH_MAP_ENV] = originalMap;
    rmSync(base, { recursive: true, force: true });
  });

  it("tells an address from a path", () => {
    expect(looksLikeMapAddress("@notes//ideas/first.md")).toBe(true);
    expect(looksLikeMapAddress(`@${ID_NOTES}//.`)).toBe(true);
    expect(looksLikeMapAddress("//ideas")).toBe(true);
    expect(looksLikeMapAddress("ideas/first.md")).toBe(false);
    expect(looksLikeMapAddress("@notes/ideas")).toBe(false);
  });

  it("reads a Space's member at HEAD from another folder, naming its root and identity", async () => {
    const { exit, data } = await run(lookCommand, ["@notes//ideas/first.md"], { map: join(space, "space.map.md") });
    expect(exit).toBe(0);
    expect(data.status).toBe("checkout_at_head");
    expect(data.root).toMatchObject({ index: 0, name: "notes", root_node_id: ID_NOTES });
    expect(data.canonical).toBe(`@${ID_NOTES}//ideas/first.md`);
    expect(data.drift).toBe(true);
    expect(data.target.summary).toBe("The wording after the pin.");
    expect(data.text).toContain("repo: @notes//");
    expect(JSON.stringify(data)).not.toContain("ideaspaces-commit-read-");
  });

  it("matches a path look's revision for the same bytes", async () => {
    const byAddress = await run(lookCommand, ["@notes//ideas/first.md"], { map: join(space, "space.map.md"), depth: "full" });
    process.chdir(notes);
    const byPath = await run(lookCommand, ["ideas/first.md"], { depth: "full" });
    expect(byPath.exit).toBe(0);
    expect(byAddress.data.target.revision).toBe(byPath.data.target.revision);
  });

  it("reads a Thread's Map at the pin, and HEAD only when asked", async () => {
    const sent = join(space, "_threads", "t", "_agent", "maps", "sent.md");
    const pinned = await run(lookCommand, [`@${ID_NOTES}//ideas/first.md`], { map: sent });
    expect(pinned.data).toMatchObject({ status: "checkout_at_pin", commit: pin, at: "pin" });
    expect(pinned.data.target.summary).toBe("The pinned wording.");

    const head = await run(lookCommand, [`@${ID_NOTES}//ideas/first.md`], { map: sent, at: "head" });
    expect(head.data).toMatchObject({ status: "checkout_at_head", drift: true });
    expect(head.data.target.summary).toBe("The wording after the pin.");
  });

  it("reads a directory's children at the commit, and focuses on it with navigate", async () => {
    const looked = await run(lookCommand, ["@notes//ideas"], { map: join(space, "space.map.md"), depth: "children" });
    expect(looked.data.target.children.map((child: { position: string }) => child.position)).toEqual(["ideas/first.md"]);

    const focus = await run(navigateCommand, ["@plans//plans"], { map: join(space, "space.map.md") }, TEXT_FLAGS);
    expect(focus.exit).toBe(0);
    expect(focus.stdout).toContain("root: plans");
    expect(focus.stdout).toContain("one.md — The first plan.");
    expect(focus.stdout).toContain("repo: @plans//");
  });

  it("uses the launch Map when no Map is named", async () => {
    process.env[LAUNCH_MAP_ENV] = join(space, "space.map.md");
    const { exit, data } = await run(lookCommand, ["@plans//plans/one.md"]);
    expect(exit).toBe(0);
    expect(data.root).toMatchObject({ name: "plans", root_node_id: ID_PLANS });
  });

  it("says how to give a Map when there is none", async () => {
    const { exit, stderr } = await run(lookCommand, ["@notes//ideas"], {}, TEXT_FLAGS);
    expect(exit).toBe(1);
    expect(stderr).toContain("pass --map <note.md>, or launch the session with --map");
  });

  it("fails loudly, by root name and identity, when a root cannot be reached", async () => {
    const { exit, stderr } = await run(lookCommand, [`@${ID_ABSENT}//`], { map: join(space, "space.map.md") }, TEXT_FLAGS);
    expect(exit).toBe(1);
    expect(stderr).toContain(ID_ABSENT);
    expect(stderr).toContain("status: unreachable");
    expect(stderr).toContain("No local checkout");
  });

  it("refuses an address with --pin and a path with --at", async () => {
    expect((await run(lookCommand, ["@notes//ideas"], { pin: pin }, TEXT_FLAGS)).exit).toBe(1);
    expect((await run(lookCommand, ["ideas"], { at: "pin" }, TEXT_FLAGS)).exit).toBe(1);
  });

  it("reads the caller's own checkout at an authored pin", async () => {
    process.chdir(notes);
    const { exit, data } = await run(lookCommand, ["ideas/first.md"], { pin });
    expect(exit).toBe(0);
    expect(data).toMatchObject({ source: "pin", commit: pin, position: "ideas/first.md" });
    expect(data.target.summary).toBe("The pinned wording.");
    expect(data.target.path).toBe(join(notes, "ideas", "first.md"));
    expect((await run(lookCommand, ["ideas/first.md"], { pin: "abc123" }, TEXT_FLAGS)).exit).toBe(1);
  });

  it("gives a launched session its own launch Map, never the caller's", () => {
    expect(launchMapEnv({ PATH: "/bin", [LAUNCH_MAP_ENV]: "/parent.md" }, "/child.md")).toEqual({ PATH: "/bin", [LAUNCH_MAP_ENV]: "/child.md" });
    expect(launchMapEnv({ PATH: "/bin", [LAUNCH_MAP_ENV]: "/parent.md" }, undefined)).toEqual({ PATH: "/bin" });
  });

  describe("launch orientation", () => {
    it("reads each member at its declared depth, shows an unreachable root by name and summary, and is stable", async () => {
      const first = await loadMapOrientation("space.map.md", space);
      const second = await loadMapOrientation("space.map.md", space);
      expect(second.text).toBe(first.text);
      expect(first.text).toContain("Budget: 12000 characters");
      expect(first.text).toContain("[0] @notes//ideas — directory, children at head");
      expect(first.text).toContain("ideas/first.md — The wording after the pin.");
      expect(first.text).toContain('map summary: "Ideas, by the curator."');
      expect(first.text).toContain("[1] @plans//plans/one.md — markdown, surface at head");
      expect(first.text).toContain("        | # Plan one");
      expect(first.text).toContain(`[2] @${ID_ABSENT}// — unreachable: No local checkout of ${ID_ABSENT}`);
      expect(first.text).toContain('map summary: "A root nobody here has."');
      expect(first.text).toContain('[3] kind=address address="https://example.com/source" depth=summary name="Primary source" (not read');
      expect(first.text).toContain("  | A legend.");
      expect(first.text).not.toContain("ideaspaces-commit-read-");
    });

    it("lowers the last member first, then the one before, rather than cutting", async () => {
      const full = (await loadMapOrientation("space.map.md", space)).text.length;
      const { text } = await loadMapOrientation("space.map.md", space, { budget: full - 20 });
      expect(text.length).toBeLessThanOrEqual(full - 20);
      // The unreachable root is last and has no bytes to lower; the plan above it goes first.
      expect(text).toMatch(/lowered to fit: \[1\] surface→(summary|name)$/m);
      expect(text).toContain("[0] @notes//ideas — directory, children at head");
    });

    it("omits the legend before refusing, and refuses when names alone do not fit", async () => {
      const long = Array.from({ length: 60 }, (_, line) => `Legend line ${line} of the curator's prose.`).join("\n");
      writeMap(join(space, "long.map.md"), [{ root_node_id: ID_PLANS, sha: "b".repeat(40), name: "plans" }], [
        { root: 0, position: "plans/one.md", depth: "full" },
      ], long);
      const roomy = await loadMapOrientation("long.map.md", space);
      expect(roomy.text).toContain("Legend line 59");
      const tight = await loadMapOrientation("long.map.md", space, { budget: 1_200 });
      expect(tight.text.length).toBeLessThanOrEqual(1_200);
      expect(tight.text).toContain("lowered to fit: [0] full→name; legend omitted");
      expect(tight.text).not.toContain("Legend line");
      await expect(loadMapOrientation("long.map.md", space, { budget: 200 })).rejects.toThrow("every member at name");
    });

    it("reads a Thread's Map at the pin", async () => {
      const { text } = await loadMapOrientation(join("_threads", "t", "_agent", "maps", "sent.md"), space);
      expect(text).toContain("a thread's Map: members read at the pin");
      expect(text).toContain('summary: "The pinned wording."');
    });
  });
});
