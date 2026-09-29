import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseFrontmatter, parseMap } from "@ideaspaces/protocol";
import { mapCommand } from "../commands/map.js";
import { navigateCommand } from "../commands/navigate.js";

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
    expect((await run(["add", file, address])).code).toBe(0);
    expect((await run(["remove", file, address])).error).toContain("matches multiple members");
    expect((await run(["remove", file, "1"], { "if-match": (await run([file])).data.file_sha })).code).toBe(0);
    expect((await run(["remove", file, address])).code).toBe(0);
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
});
