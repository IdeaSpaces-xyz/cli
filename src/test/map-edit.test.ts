import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseFrontmatter, parseMap } from "@ideaspaces/protocol";
import { mapCommand } from "../commands/map.js";
import { agentCommand } from "../commands/agent.js";
import { navigateCommand } from "../commands/navigate.js";
import { loadMapNote } from "../local/map-note.js";
import { loadMapOrientation } from "../local/map-orientation.js";
import * as mapCheckouts from "../local/map-checkouts.js";
import { claudeConversationOps as claudeConversation } from "../claude/local-conversation-ops.js";
import { localConversationOps as piConversation } from "../pi/local-conversation-ops.js";
import { resolveMapAddress } from "../local/map-resolve.js";

const global = { json: true, quiet: false, yes: false, help: false };
const dirs: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(join(tmpdir(), "map-edit-"));
  dirs.push(dir);
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

async function run(args: string[], flags: Record<string, string | boolean> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof stdout;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof stderr;
  try {
    const code = await mapCommand.run(args, flags, global);
    return { code, data: out.length ? JSON.parse(out.join("")) : null, error: err.join("") };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

function cli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve("bundle/ideaspaces.js"), ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => done({ code, output }));
  });
}

describe("map authoring", () => {
  it("creates a Space Map, refuses replacement, and opens it", async () => {
    const dir = await directory();
    const file = join(dir, "team.map.md");
    expect((await run(["create", file], { name: "Team", summary: "Our team" })).code).toBe(0);
    expect((await run([file])).data).toMatchObject({ kind: "space-map", name: "Team", roots: [], members: [] });
    expect((await run(["create", file], { name: "Other", summary: "No" })).code).toBe(1);
    expect((await fs.readFile(file, "utf8"))).toContain("name: Team");
  });

  it("writes shallow Space pointers without a pin or depth", async () => {
    const dir = await directory();
    const file = join(dir, "home.map.md");
    expect((await run(["create", file], { name: "Home", summary: "What is here" })).code).toBe(0);
    const added = await run(["add", file], { position: ".", "root-node-id": "n_0123456789abcdef01234567" });
    expect(added.code).toBe(0);
    const opened = (await run([file])).data;
    expect(opened.map.roots).toEqual([{ root_node_id: "n_0123456789abcdef01234567" }]);
    expect(opened.map.members).toEqual([{ root: 0, position: "." }]);
    expect(opened.roots[0].drift).toBe(false);
    expect(await fs.readFile(file, "utf8")).not.toContain("sha:");
  });

  it("K1: registers a checkout without storing its path in a Map kept elsewhere, for all readers", async () => {
    const dir = await directory();
    const maps = join(dir, "maps");
    const agent = join(await directory(), "steward");
    await fs.mkdir(maps, { recursive: true });
    await fs.mkdir(join(agent, "_agent"), { recursive: true });
    spawnSync("git", ["init", "-q", agent]);
    spawnSync("git", ["-C", agent, "config", "user.name", "Test"]);
    spawnSync("git", ["-C", agent, "config", "user.email", "test@example.com"]);
    const id = "n_0123456789abcdef01234567";
    await fs.writeFile(join(agent, "_agent/agreement.md"), `---\nname: Steward\nsummary: Agent in another checkout\nagreement: agent:repo:${id}\nroot_node_id: ${id}\n---\n# Steward\n`);
    await fs.mkdir(join(agent, "_threads", "local"), { recursive: true });
    await fs.writeFile(join(agent, "_threads/local/README.md"), "# Local Thread\n");
    await fs.writeFile(join(agent, "note.md"), "---\nname: A note\nsummary: A local note\n---\n# A note\n");
    spawnSync("git", ["-C", agent, "add", "."]);
    expect(spawnSync("git", ["-C", agent, "commit", "-qm", "fixture"]).status).toBe(0);
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    process.env.HOME = join(dir, "isolated-home");
    await fs.mkdir(process.env.HOME);
    try {
      const file = join(maps, "fresh.map.md");
      expect((await run(["create", file], { name: "Fresh", summary: "A new Space" })).code).toBe(0);
      const stale = await run(["add", file], { position: ".", checkout: agent, "if-match": "0".repeat(64) });
      expect(stale.error).toContain("Map base moved");
      expect(existsSync(join(process.env.HOME!, ".ideaspaces", "map-checkouts.json"))).toBe(false);
      expect((await run(["add", file], { position: ".", checkout: agent })).code).toBe(0);
      const checkouts = JSON.parse(await fs.readFile(join(process.env.HOME!, ".ideaspaces", "map-checkouts.json"), "utf8"));
      expect(checkouts[realpathSync(agent)]).toBe(id);
      const hintFile = join(process.env.HOME!, ".ideaspaces", "map-checkouts.json");
      await fs.writeFile(hintFile, "{invalid json");
      expect(() => mapCheckouts.loadMapCheckouts()).toThrow("Repair or move that file");
      await fs.writeFile(hintFile, JSON.stringify({ relative: id }));
      expect(() => mapCheckouts.loadMapCheckouts()).toThrow("Invalid Map checkout hints");
      await fs.writeFile(hintFile, JSON.stringify(checkouts));
      // Older CLIs only rewrite spaces.json, not Map checkout hints.
      expect(existsSync(join(process.env.HOME!, ".ideaspaces", "spaces.json"))).toBe(false);
      expect((await run(["add", file], { position: "note.md", root: "0" })).code).toBe(0);
      expect((await run(["add", file], { position: "_threads/local", root: "0" })).code).toBe(0);
      expect((await run(["add", file, "https://example.com/"])).code).toBe(0);
      const opened = (await run([file])).data;
      expect(opened.roots[0]).toMatchObject({ status: "found", checkout_path: await fs.realpath(agent) });
      expect(opened.map.roots[0]).toEqual({ root_node_id: id });
      expect(await fs.readFile(file, "utf8")).not.toContain(agent);
      process.chdir(process.env.HOME);
      const resolved = resolveMapAddress(loadMapNote(file, dir), `@${id}//note.md`);
      expect(resolved).toMatchObject({ status: "checkout_at_head", content: expect.stringContaining("A local note") });
      const output: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof write;
      try { expect(await agentCommand.run(["list"], { map: file }, global)).toBe(0); }
      finally { process.stdout.write = write; }
      expect(JSON.parse(output.join("")).agents[0]).toMatchObject({ name: "Steward", path: await fs.realpath(agent) });
      const orientation = await loadMapOrientation(file, dir);
      expect(orientation.text).toContain("A local note");
      expect(orientation.text).toContain("_threads/local");
      expect(orientation.text).toContain("https://example.com/");
    } finally {
      process.env.HOME = originalHome;
      process.chdir(originalCwd);
    }
  }, 30_000);

  it("K2: reuses roots, safely repeats writes, removes by position address and reindexes survivors", async () => {
    const dir = await directory();
    const file = join(dir, "k2.map.md");
    const first = "n_0123456789abcdef01234567";
    const second = "n_ffffffffffffffffffffffff";
    const third = "n_aaaaaaaaaaaaaaaaaaaaaaaa";
    const url = "https://example.com/pricing";
    expect((await run(["create", file], { name: "K2", summary: "Edits" })).code).toBe(0);
    expect((await run(["add", file], { position: ".", "root-node-id": first })).code).toBe(0);
    const stable = await fs.readFile(file, "utf8");
    expect((await run(["add", file], { position: ".", "root-node-id": first })).data.status).toBe("already_present");
    expect(await fs.readFile(file, "utf8")).toBe(stable);
    expect((await run(["add", file], { position: ".", "root-node-id": first, summary: "changed" })).error).toContain("different annotations");
    expect(await fs.readFile(file, "utf8")).toBe(stable);
    expect((await run(["add", file], { position: "frictions", "root-node-id": first })).code).toBe(0);
    expect((await run(["add", file], { position: ".", "root-node-id": second })).code).toBe(0);
    expect((await run(["add", file], { position: "_threads/local", "root-node-id": third })).code).toBe(0);
    expect((await run(["add", file], { position: "note.md", "root-node-id": first })).code).toBe(0);
    expect((await run(["add", file, url])).code).toBe(0);
    expect((await run(["add", file, `agent:repo:${second}`])).code).toBe(0);
    expect((await run(["add", file, "thread:x_0123456789abcdef01234567"])).code).toBe(0);
    expect((await run([file])).data.map.roots).toHaveLength(3);
    expect((await run(["remove", file, `@${first}//frictions`])).data.status).toBe("removed");
    expect((await run(["remove", file, `@${second}//`])).data.status).toBe("removed");
    expect((await run(["remove", file], { "root-node-id": first })).error).toContain("still has members");
    const after = (await run([file])).data.map;
    expect(after.roots).toEqual([{ root_node_id: first }, { root_node_id: second }, { root_node_id: third }]);
    expect(after.members).toEqual([
      { root: 0, position: "." }, { root: 2, position: "_threads/local" }, { root: 0, position: "note.md" },
      { address: url }, { address: `agent:repo:${second}` }, { address: "thread:x_0123456789abcdef01234567" },
    ]);
    const bytes = await fs.readFile(file, "utf8");
    expect((await run(["remove", file, `@${second}//`])).data.status).toBe("already_absent");
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    expect((await run(["remove", file, `@${first}//../outside`])).error).toContain("Invalid position address");
    expect((await run(["remove", file], { "root-node-id": first, position: "." })).data.status).toBe("removed");
    expect((await run(["remove", file, `@${first}//note.md`])).data.status).toBe("removed");
    expect((await run([file])).data.map.roots).toEqual([{ root_node_id: first }, { root_node_id: second }, { root_node_id: third }]);
    expect((await run(["remove", file, `@${third}//_threads/local`])).data.status).toBe("removed");
    expect((await run([file])).data.map).toMatchObject({ roots: [{ root_node_id: first }, { root_node_id: second }, { root_node_id: third }], members: [{ address: url }, { address: `agent:repo:${second}` }, { address: "thread:x_0123456789abcdef01234567" }] });
    expect((await run(["remove", file, "@typo//missing.md"])).error).toContain("unknown_name");
    expect((await run(["remove", file], { "root-node-id": second })).data.status).toBe("root_removed");
    expect((await run([file])).data.map.roots).toEqual([{ root_node_id: first }, { root_node_id: third }]);
    expect((await run(["remove", file], { "root-node-id": first })).data.status).toBe("root_removed");
    expect((await run(["remove", file], { "root-node-id": third })).data.status).toBe("root_removed");
    expect((await run([file])).data.map.roots).toEqual([]);
  });

  it("reuses a canonical repo root and refuses an implicit pin change", async () => {
    const dir = await directory();
    const file = join(dir, "legacy.map.md");
    const id = "n_0123456789abcdef01234567";
    const sha = "a".repeat(40);
    await fs.writeFile(file, `---\nname: Legacy\nmap:\n  roots:\n    - repo: https://ideaspaces.xyz/repos/${id}\n      sha: ${sha}\n  members:\n    - root: 0\n      position: .\n---\n`);
    const original = await fs.readFile(file, "utf8");
    expect((await run(["add", file], { position: "note.md", "root-node-id": id })).error).toContain(`pinned to ${sha}, but this add requested no pin`);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect((await run(["add", file], { position: "note.md", "root-node-id": id, sha })).data.status).toBe("added");
    expect((await run([file])).data.map).toMatchObject({ roots: [{ repo: `https://ideaspaces.xyz/repos/${id}`, sha }], members: [{ root: 0, position: "." }, { root: 0, position: "note.md" }] });
  });

  it("recognises a README Map as the folder's Space in map and navigate", async () => {
    const dir = await directory();
    const file = join(dir, "README.md");
    await fs.writeFile(file, "---\nname: Reading Room\nsummary: A room.\nmap:\n  roots: []\n  members: []\n---\n# Read me\n");
    expect((await run([dir])).data).toMatchObject({ kind: "space-map", file: "README.md", name: "Reading Room" });
    const written: string[] = [];
    const stdout = process.stdout.write;
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof stdout;
    try {
      expect(await navigateCommand.run([dir], {}, global)).toBe(0);
    } finally { process.stdout.write = stdout; }
    expect(JSON.parse(written.join(""))).toMatchObject({ space: "README.md" });
  });

  it("appends both member kinds, preserves annotations, removes by index and refuses a stale base", async () => {
    const dir = await directory();
    const file = join(dir, "README.md");
    await fs.writeFile(file, "---\nname: Space\ncustom: retained\nmap:\n  custom: preserved\n  roots: []\n  members: []\n---\n\n# Legend\n");
    const original = await run(["add", file, "thread:x_0123456789abcdef01234567"], { depth: "summary" });
    expect(original.code).toBe(0);
    const base = original.data.sha;
    const position = await run(["add", file], { position: ".", depth: "surface", "root-node-id": "n_0123456789abcdef01234567", sha: "a".repeat(40) });
    expect(position.code).toBe(0);
    const stale = await run(["remove", file, "0"], { "if-match": base });
    expect(stale.code).toBe(1);
    expect(stale.error).toContain("Map base moved");
    const opened = (await run([file])).data;
    expect(opened.file_sha).toBe(position.data.sha);
    const map = opened.map;
    expect(map.roots).toHaveLength(1);
    expect(map.members).toMatchObject([{ address: "thread:x_0123456789abcdef01234567" }, { root: 0, position: ".", depth: "surface" }]);
    expect((await run(["remove", file, "0"])).error).toContain("requires --if-match");
    expect((await run(["remove", file, "0"], { "if-match": (await run([file])).data.file_sha })).code).toBe(0);
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("custom: retained");
    expect(content).toContain("custom: preserved");
    expect(content).toContain("# Legend");
    expect(parseMap(parseFrontmatter(content)?.map)).toMatchObject({ status: "valid", map: { members: [{ root: 0, position: "." }] } });
    expect((await run(["add", file, "not-an-address"])).code).toBe(1);
  });

  it("refuses ambiguous addresses, stale adds and invalid inputs without changing the file", async () => {
    const dir = await directory();
    const file = join(dir, "team.map.md");
    expect((await run(["create", join(dir, "missing", "team.map.md")], { name: "Team", summary: "T" })).error).toContain("check the map path");
    await fs.writeFile(file, "---\nname: Team\nmap:\n  roots: []\n  members: []\n---\n# Team\n");
    const initial = await fs.readFile(file, "utf8");
    expect((await run(["add", file], { position: ".", depth: "summary", root: "0" })).error).toContain("Map has no roots");
    expect((await run(["add", file, "bad"])).error).toContain("Invalid member");
    expect((await run(["add", file, "thread:x_0123456789abcdef01234567"], { "if-match": "0".repeat(64) })).error).toContain("Map base moved");
    expect(await fs.readFile(file, "utf8")).toBe(initial);
    const address = "thread:x_0123456789abcdef01234567";
    expect((await run(["add", file, address])).code).toBe(0);
    const beforeRepeat = await fs.readFile(file, "utf8");
    expect((await run(["add", file, address])).data.status).toBe("already_present");
    expect(await fs.readFile(file, "utf8")).toBe(beforeRepeat);
    expect((await run(["remove", file, address])).code).toBe(0);
    expect((await run(["remove", file, address])).data.status).toBe("already_absent");
    expect((await run([file])).data.members).toEqual([]);
    await fs.writeFile(file, "---\nname: Broken\nmap: [\n---\n# Still a Note\n");
    expect((await run(["add", file, address])).error).toContain("Invalid YAML");
    expect((await run([dir])).error).toContain("Could not open Space Map");
    await fs.writeFile(file, "# No frontmatter\n");
    expect((await run(["add", file, address])).error).toContain("No valid YAML frontmatter");
    await fs.mkdir(join(dir, "folder.map.md"));
    expect((await run(["add", join(dir, "folder.map.md"), address])).code).toBe(1);
  });

  it("preserves CRLF notes and refuses a held lock without stealing it", async () => {
    const dir = await directory();
    const file = join(dir, "team.map.md");
    await fs.writeFile(file, "---\r\nname: Team\r\nmap:\r\n  roots: []\r\n  members: []\r\n---\r\n\r\n# Legend\r\n");
    const lock = `${await fs.realpath(file)}.lock`;
    await fs.mkdir(lock);
    const refused = await run(["add", file, "thread:x_0123456789abcdef01234567"]);
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("Map is locked");
    expect(refused.error).toContain("confirm no writer is running");
    expect((await run([file])).data.members).toEqual([]);
    await fs.rmdir(lock);
    expect((await run(["add", file, "thread:x_0123456789abcdef01234567"])).code).toBe(0);
    const content = await fs.readFile(file, "utf8");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
    expect(content).toContain("---\r\n\r\n# Legend\r\n");
  }, 10_000);

  it("reports success rather than inviting a duplicate add when lock cleanup fails", async () => {
    const dir = await directory();
    const file = join(dir, "team.map.md");
    expect((await run(["create", file], { name: "Team", summary: "T" })).code).toBe(0);
    const removeLock = vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const result = await run(["add", file, "thread:x_0123456789abcdef01234567"]);
      expect(result.code).toBe(0);
      expect(result.error).toContain("edit succeeded, but could not release");
      expect((await run([file])).data.members).toHaveLength(1);
    } finally { removeLock.mockRestore(); }
  });

  it("does not hide an invalid README Map by deriving a tree", async () => {
    const dir = await directory();
    await fs.writeFile(join(dir, "README.md"), "---\nname: Broken\nmap: [\n---\n# Still a Note\n");
    const result = await run([dir]);
    expect(result.code).toBe(1);
    expect(result.error).toContain("Could not open Space Map");
  });

  // CI's npm ci runs prepare/build before tests. Direct Vitest on an unbuilt
  // checkout can still exercise every unit test; build before the process race.
  it.skipIf(!existsSync(resolve("bundle/ideaspaces.js")))("serializes independent CLI processes (requires npm run build): neither add is silently lost", async () => {
    const dir = await directory();
    const file = join(dir, "team.map.md");
    expect((await run(["create", file], { name: "Team", summary: "Two writers" })).code).toBe(0);
    const results = await Promise.all([
      cli(["map", "add", file, "thread:x_111111111111111111111111", "--depth", "summary"]),
      cli(["map", "add", file, "thread:x_222222222222222222222222", "--depth", "summary"]),
    ]);
    expect(results, JSON.stringify(results)).toEqual([{ code: 0, output: expect.any(String) }, { code: 0, output: expect.any(String) }]);
    const opened = (await run([file])).data;
    expect(opened.members.map((m: { address: string }) => m.address).sort()).toEqual([
      "thread:x_111111111111111111111111", "thread:x_222222222222222222222222",
    ]);
  });

  it("K3/C2: Space Map orientation renders typed shallow pointers, agent roster, empty state, and CLI edit guidance without pin undefined", async () => {
    const dir = await directory();
    const maps = join(dir, "maps");
    await fs.mkdir(maps, { recursive: true });

    const agentDir = join(await directory(), "specialist");
    await fs.mkdir(join(agentDir, "_agent"), { recursive: true });
    await fs.mkdir(join(agentDir, "_threads", "discussions"), { recursive: true });
    await fs.mkdir(join(agentDir, "notes"), { recursive: true });
    spawnSync("git", ["init", "-q", agentDir]);
    spawnSync("git", ["-C", agentDir, "config", "user.name", "Specialist"]);
    spawnSync("git", ["-C", agentDir, "config", "user.email", "specialist@example.com"]);
    const agentId = "n_111111111111111111111111";
    await fs.writeFile(
      join(agentDir, "_agent/agreement.md"),
      `---\nname: Specialist\nsummary: Specialist agent\nagreement: agent:repo:${agentId}\nroot_node_id: ${agentId}\n---\n# Specialist\n`,
    );
    await fs.writeFile(join(agentDir, "_threads/discussions/README.md"), "# Discussions\n");
    await fs.writeFile(join(agentDir, "guide.map.md"), "---\nname: Guide Map\nmap:\n  roots: []\n  members: []\n---\n");
    await fs.writeFile(join(agentDir, "notes", "doc.md"), "---\nname: Doc\nsummary: Documentation\n---\n# Doc\n");
    spawnSync("git", ["-C", agentDir, "add", "."]);
    spawnSync("git", ["-C", agentDir, "commit", "-qm", "agent fixture"]);

    const repoDir = join(await directory(), "repo");
    await fs.mkdir(join(repoDir, "_agent"), { recursive: true });
    spawnSync("git", ["init", "-q", repoDir]);
    spawnSync("git", ["-C", repoDir, "config", "user.name", "Repo"]);
    spawnSync("git", ["-C", repoDir, "config", "user.email", "repo@example.com"]);
    const repoId = "n_222222222222222222222222";
    await fs.writeFile(
      join(repoDir, "_agent/agreement.md"),
      `---\nname: Repo\nsummary: Plain repository\nroot_node_id: ${repoId}\n---\n# Repo\n`,
    );
    spawnSync("git", ["-C", repoDir, "add", "."]);
    spawnSync("git", ["-C", repoDir, "commit", "-qm", "repo fixture"]);

    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    process.env.HOME = join(dir, "isolated-home");
    await fs.mkdir(process.env.HOME);

    try {
      const file = join(maps, "k3.map.md");
      expect((await run(["create", file], { name: "K3 Space", summary: "Orientation test" })).code).toBe(0);

      // 1. Empty Space Map orientation
      const emptyOrientation = await loadMapOrientation(file, dir);
      expect(emptyOrientation.text).toContain('Name: "K3 Space"');
      expect(emptyOrientation.text).toContain('Summary: "Orientation test"');
      expect(emptyOrientation.text).toContain("This Map's roots are the Space.");
      expect(emptyOrientation.text).toContain("This Space is empty: it has no roots. Work from the separate POV, say the Space is empty, and offer to add a root.");
      expect(emptyOrientation.text).not.toContain(`default folder for new material): "${maps}"`);
      expect(emptyOrientation.firstRoot).toBeUndefined();
      expect(emptyOrientation.localRoots).toEqual([]);
      expect(emptyOrientation.text).toContain(`Edit this Space with ideaspaces map add "${resolve(file)}" or ideaspaces map remove "${resolve(file)}"; run ideaspaces map --help for forms.`);
      expect(emptyOrientation.text).toContain("This Space has no selected members.");
      expect(emptyOrientation.text).toContain("Agents in this Space (0):");
      expect(emptyOrientation.text).toContain("(none selected or reachable here)");

      // 2. Add members of various types
      const failedRegistry = vi.spyOn(mapCheckouts, "saveMapCheckout").mockImplementationOnce(() => { throw new Error("hint store unavailable"); });
      const partial = await run(["add", file], { position: ".", checkout: agentDir });
      expect(partial.code).toBe(1);
      expect(partial.data.status).toBe("added_unregistered");
      expect(partial.error).toContain("Map edit succeeded but checkout registration failed");
      failedRegistry.mockRestore();
      expect((await run(["add", file], { position: ".", checkout: agentDir })).data.status).toBe("already_present");
      expect(mapCheckouts.loadMapCheckouts()[realpathSync(agentDir)]).toBe(agentId);
      expect((await run(["add", file], { position: ".", checkout: repoDir })).code).toBe(0);
      expect((await run(["add", file], { position: "_threads/discussions", root: "0" })).code).toBe(0);
      expect((await run(["add", file], { position: "guide.map.md", root: "0" })).code).toBe(0);
      expect((await run(["add", file], { position: "notes", root: "0" })).code).toBe(0);
      expect((await run(["add", file], { position: "notes/doc.md", root: "0" })).code).toBe(0);
      const absentId = "n_999999999999999999999999";
      expect((await run(["add", file], { position: ".", "root-node-id": absentId })).code).toBe(0);
      expect((await run(["add", file, "https://example.com/docs"])).code).toBe(0);
      expect((await run(["add", file, "thread:x_0123456789abcdef01234567"])).code).toBe(0);
      expect((await run(["add", file, "agent:repo:n_ext"])).code).toBe(0);

      // 3. Orientation of populated unpinned Space Map
      const orientation = await loadMapOrientation(file, dir);
      const text = orientation.text;

      // No "pin undefined"
      expect(text).not.toContain("pin undefined");
      expect(text).not.toContain("drifted from pin undefined");

      // Root resolution state and ordered working material (not the Map storage folder).
      expect(orientation.firstRoot).toBe(realpathSync(agentDir));
      expect(orientation.localRoots).toEqual([realpathSync(agentDir), realpathSync(repoDir)]);
      expect(text).toContain(`First root (default folder for new material): "${realpathSync(agentDir)}"`);
      expect(text).toContain("The shell starts in the POV, not this root");
      expect(text).not.toContain(`default folder for new material): "${maps}"`);
      expect(text).toContain(`[0] @specialist — ${agentId} — found at HEAD`);
      expect(text).toContain(`[1] @repo — ${repoId} — found at HEAD`);
      expect(text).toContain(`[2] @${absentId} — ${absentId} — unavailable here (no local checkout)`);

      // Member typing
      expect(text).toContain("[0] @specialist// — Agent, directory, summary at head");
      expect(text).toContain("[1] @repo// — Repo, directory, summary at head");
      expect(text).toContain("[2] @specialist//_threads/discussions — Thread,");
      expect(text).toContain("[3] @specialist//guide.map.md — Map, markdown, summary at head");
      expect(text).toContain("[4] @specialist//notes — Folder, directory, summary at head");
      expect(text).toContain("[5] @specialist//notes/doc.md — Note, markdown, summary at head");
      expect(text).toContain(`[6] @${absentId}// — Repo, unreachable: No local checkout`);
      expect(text).toContain('[7] kind="URL (not fetched)" address="https://example.com/docs"');
      expect(text).toContain('[8] kind="Hosted Thread" address="thread:x_0123456789abcdef01234567"');
      expect(text).toContain('[9] kind="Agent address" address="agent:repo:n_ext"');

      // Agents in this Space
      expect(text).toContain("Agents in this Space (1):");
      expect(text).toContain('"Specialist" —');
      expect(text).toContain('"Specialist agent"');
      expect(text).not.toContain('"Repo" —');

      // Budget check
      expect(text.length).toBeLessThanOrEqual(12_000);

      // A pre-Map Desktop still sends the Map storage folder as --working-root.
      // Both runtimes must override that material instruction, but preserve POV cwd.
      const claudeArgsFile = join(dir, "claude-args.json");
      const fakeClaude = join(dir, "fake-claude.cjs");
      await fs.writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(claudeArgsFile)}, JSON.stringify({args, cwd: process.cwd()}));
const id = args[args.indexOf('--session-id') + 1];
console.log(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'fake',cwd:process.cwd()}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}));
`);
      await fs.chmod(fakeClaude, 0o755);
      const errors: string[] = [];
      const output = { result() {}, log() {}, progress() {}, error(message: string) { errors.push(message); } };
      const stdout = process.stdout.write;
      process.stdout.write = (() => true) as typeof stdout;
      try {
        expect(await claudeConversation.send({
          context: dir, map: file, "working-root": maps, focus: "notes/doc.md", message: "Where is the Space?",
          conversation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "claude-bin": fakeClaude,
        }, output)).toBe(0);
      } finally {
        process.stdout.write = stdout;
      }
      expect(errors).toEqual([]);
      const invoked = JSON.parse(await fs.readFile(claudeArgsFile, "utf8")) as { args: string[]; cwd: string };
      expect(invoked.cwd).toBe(realpathSync(dir));
      expect(invoked.args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
      expect(invoked.args).toContain(realpathSync(agentDir));
      expect(invoked.args).toContain(realpathSync(repoDir));
      expect(invoked.args).not.toContain(realpathSync(maps));
      const prompt = invoked.args[invoked.args.indexOf("--append-system-prompt") + 1];
      expect(prompt).toContain("This Map's roots are the Space");
      expect(prompt).toContain(`First root (default folder for new material): "${realpathSync(agentDir)}"`);
      expect(prompt).not.toContain(`"workingRoot":"${realpathSync(maps)}"`);
      expect(prompt).toContain('"focus":"notes/doc.md"');

      const fakePi = join(dir, "fake-pi.cjs");
      const piArgsFile = join(dir, "pi-args.json");
      await fs.writeFile(fakePi, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(piArgsFile)}, JSON.stringify({args, cwd: process.cwd()}));
process.stdin.on('data', d => {
  if (!String(d).includes('"type":"prompt"')) return;
  console.log(JSON.stringify({type:'response',command:'prompt',success:true}));
  console.log(JSON.stringify({type:'agent_start'}));
  console.log(JSON.stringify({type:'turn_start'}));
  console.log(JSON.stringify({type:'agent_end'}));
});
`);
      await fs.chmod(fakePi, 0o755);
      process.stdout.write = (() => true) as typeof stdout;
      try {
        expect(await piConversation.send({
          context: dir, map: file, "working-root": maps, focus: "notes/doc.md", message: "Where is the Space?",
          conversation: "map-root-test", ext: "/fake/extension", "pi-bin": fakePi,
        }, output)).toBe(0);
      } finally {
        process.stdout.write = stdout;
      }
      expect(errors).toEqual([]);
      const piInvoked = JSON.parse(await fs.readFile(piArgsFile, "utf8")) as { args: string[]; cwd: string };
      expect(piInvoked.cwd).toBe(realpathSync(dir));
      const piPrompt = piInvoked.args[piInvoked.args.indexOf("--append-system-prompt") + 1];
      expect(piPrompt).toContain("This Map's roots are the Space");
      expect(piPrompt).not.toContain(`"workingRoot":"${realpathSync(maps)}"`);
      expect(piPrompt).toContain('"focus":"notes/doc.md"');
    } finally {
      process.env.HOME = originalHome;
      process.chdir(originalCwd);
    }
  }, 30_000);
});
