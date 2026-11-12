import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../auth/credentials.js";
import { loadSpaces } from "../auth/spaces.js";
import { lookCommand } from "../commands/look.js";
import { mapCommand, rootImage } from "../commands/map.js";
import type { CommandDef, GlobalFlags } from "../types.js";

vi.mock("../auth/credentials.js", async (importOriginal) => {
  const loadConfig = vi.fn(() => null);
  return { ...(await importOriginal<typeof import("../auth/credentials.js")>()), loadConfig, peekConfig: () => loadConfig() };
});
vi.mock("../auth/spaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/spaces.js")>()),
  loadSpaces: vi.fn(() => ({})),
}));

// Windows CI runs these slowly; give each the CLI suite's 30 s.
const SLOW = { timeout: 30_000 };
const JSON_FLAGS: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_FLAGS: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;
let originalCwd: string;
const originalHome = process.env.HOME;

async function run(command: CommandDef, args: string[], global: GlobalFlags = JSON_FLAGS) {
  const stdout: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await command.run(args, {}, global);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  const out = stdout.join("");
  return { exit, out, data: global.json && out ? JSON.parse(out) : null };
}

/** A child Git repo with a root id and a README carrying `readme` front matter. */
async function child(name: string, id: string, readme: string, files: Record<string, Buffer | string> = {}): Promise<string> {
  const dir = join(root, name);
  await fs.mkdir(join(dir, "_agent"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "c@e.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "C"], { cwd: dir });
  await fs.writeFile(join(dir, "_agent", "agreement.md"), `---\nname: ${name}\nroot_node_id: ${id}\n---\n# Agreement\n`);
  await fs.writeFile(join(dir, "README.md"), `---\nname: ${name}\n${readme}---\n\n# ${name}\n`);
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(join(dir, path, ".."), { recursive: true });
    await fs.writeFile(join(dir, path), content);
  }
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-repo-image-")));
  process.env.HOME = root;
  originalCwd = process.cwd();
  process.chdir(root);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  vi.mocked(loadConfig).mockReturnValue(null);
  vi.mocked(loadSpaces).mockReturnValue({});
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(root, { recursive: true, force: true });
});

describe("a repo's identity image", () => {
  it("look on a repo root returns the resolved image, and shows it", SLOW, async () => {
    const repo = await child("field-notes", "n_111111111111111111111111", "image: _assets/icon.png\n", { "_assets/icon.png": PNG });
    const json = await run(lookCommand, [repo]);
    expect(json.exit).toBe(0);
    expect(json.data.target.image).toEqual({ status: "ok", path: "_assets/icon.png", mediaType: "image/png" });
    const text = await run(lookCommand, [repo], TEXT_FLAGS);
    expect(text.out).toContain("  image: _assets/icon.png (image/png)");
  });

  it("look reports a bad image and still answers", SLOW, async () => {
    const repo = await child("field-notes", "n_111111111111111111111111", "image: https://example.com/a.png\n");
    const json = await run(lookCommand, [repo]);
    expect(json.exit).toBe(0);
    expect(json.data.target.image).toMatchObject({ status: "problem", code: "invalid_reference" });
    const svg = await child("vector", "n_333333333333333333333333", "image: _assets/mark.svg\n", {
      "_assets/mark.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>\n',
    });
    expect((await run(lookCommand, [svg])).data.target.image).toMatchObject({ status: "problem", code: "unsupported_type", declared: "_assets/mark.svg" });
    const none = await child("plain", "n_222222222222222222222222", "");
    expect((await run(lookCommand, [none])).data.target.image).toBeUndefined();
  });

  it("map --json gives each root its image, null, or null with the problem", SLOW, async () => {
    const withImage = await child("scout", "n_111111111111111111111111", "image: _assets/avatar.png\n", { "_assets/avatar.png": PNG });
    await child("plain", "n_222222222222222222222222", "");
    await child("big", "n_333333333333333333333333", "image: _assets/huge.png\n", {
      "_assets/huge.png": Buffer.concat([PNG, Buffer.alloc(262_144)]),
    });
    await fs.writeFile(join(root, "home.map.md"), `---
name: Home
summary: The Space.
map:
  roots:
    - root_node_id: n_111111111111111111111111
    - root_node_id: n_222222222222222222222222
    - root_node_id: n_333333333333333333333333
    - root_node_id: n_444444444444444444444444
  members:
    - root: 0
      position: README.md
    - root: 1
      position: README.md
---
`);
    const json = await run(mapCommand, ["."]);
    expect(json.exit).toBe(0);
    const roots = json.data.roots;
    expect(roots[0].image).toEqual({ path: "_assets/avatar.png", absolute_path: realpathSync.native(join(withImage, "_assets", "avatar.png")), media_type: "image/png" });
    expect(roots[0].image_problem).toBeUndefined();
    expect(roots[1]).toMatchObject({ image: null });
    expect(roots[1].image_problem).toBeUndefined();
    expect(roots[2]).toMatchObject({ image: null, image_problem: { code: "too_large", declared: "_assets/huge.png" } });
    expect(roots[3]).toMatchObject({ checkout_path: null, image: null });

    const text = await run(mapCommand, ["."], TEXT_FLAGS);
    expect(text.out).toContain("      image: _assets/avatar.png (image/png)");
    expect(text.out).toContain("      image: not shown (too_large): ");
  });

  it("a root with no checkout has no image, and an unreadable root is a problem, not a failure", async () => {
    expect(await rootImage(null)).toEqual({ image: null });
    const result = await rootImage(join(root, "does-not-exist"));
    expect(result).toMatchObject({ image: null, image_problem: { code: "unreadable" } });
  });
});
