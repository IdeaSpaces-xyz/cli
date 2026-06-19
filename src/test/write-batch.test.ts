import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCommand } from "../commands/write.js";
import { captureJson } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

let tmp: string;
let cwd: string;

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: tmp, encoding: "utf-8" }).stdout.trim();
}

async function seed(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, body, "utf-8");
}

const HEALTHY = `---\nname: A\nsummary: about a\n---\n# A\nsee [b](b.md)\n`;

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-write-batch-")));
  cwd = process.cwd();
  process.chdir(tmp);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "T"], { cwd: tmp });
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces write — batch stage", () => {
  it("stages every .md under a directory in one call", async () => {
    await seed("notes/a.md", HEALTHY);
    await seed("notes/sub/b.md", HEALTHY);
    await seed("notes/skip.txt", "not markdown");

    const exit = await writeCommand.run(["notes"], {}, G);
    expect(exit).toBe(0);

    const staged = git(["diff", "--cached", "--name-only"]).split("\n");
    expect(staged).toContain("notes/a.md");
    expect(staged).toContain("notes/sub/b.md");
    expect(staged).not.toContain("notes/skip.txt");
    // Batch stages, never commits.
    expect(git(["rev-list", "--count", "--all"])).toBe("0");
  });

  it("stages an explicit set of files (2+ paths)", async () => {
    await seed("a.md", HEALTHY);
    await seed("b.md", HEALTHY);

    const exit = await writeCommand.run(["a.md", "b.md"], {}, G);
    expect(exit).toBe(0);
    const staged = git(["diff", "--cached", "--name-only"]).split("\n");
    expect(staged).toEqual(expect.arrayContaining(["a.md", "b.md"]));
  });

  it("surfaces an explicit non-.md file as skipped, still stages the .md", async () => {
    await seed("a.md", HEALTHY);
    await seed("readme.txt", "not markdown");
    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      errs.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;
    let exit: number;
    try {
      exit = await writeCommand.run(["a.md", "readme.txt"], {}, { ...G, quiet: false });
    } finally {
      process.stderr.write = origErr;
    }
    expect(exit).toBe(0);
    expect(errs.join("")).toContain("Skipped (not .md): readme.txt");
    const staged = git(["diff", "--cached", "--name-only"]).split("\n");
    expect(staged).toContain("a.md");
    expect(staged).not.toContain("readme.txt");
  });

  it("reports per-file health issues in the result", async () => {
    await seed("notes/good.md", HEALTHY);
    await seed("notes/bare.md", "# bare\nno frontmatter, no links\n");
    const { exit, json } = await captureJson(() => writeCommand.run(["notes"], {}, G));
    expect(exit).toBe(0);
    const bare = json.files.find((f: { path: string }) => f.path.endsWith("bare.md"));
    expect(bare.issues).toEqual(
      expect.arrayContaining(["no frontmatter", "no summary", "no outbound links"]),
    );
    const good = json.files.find((f: { path: string }) => f.path.endsWith("good.md"));
    expect(good.issues).toEqual([]);
  });

  it("an image-only body counts as having no outbound links", async () => {
    await seed("notes/img.md", "---\nname: I\nsummary: s\n---\n# I\n![pic](pic.png)\n");
    const { json } = await captureJson(() => writeCommand.run(["notes"], {}, G));
    const img = json.files.find((f: { path: string }) => f.path.endsWith("img.md"));
    expect(img.issues).toContain("no outbound links");
  });

  it("includes missing and skipped targets in the JSON payload", async () => {
    await seed("a.md", HEALTHY);
    await seed("readme.txt", "nope");
    const { exit, json } = await captureJson(() =>
      writeCommand.run(["a.md", "readme.txt", "ghost.md"], {}, G),
    );
    expect(exit).toBe(0);
    expect(json.skipped).toEqual(["readme.txt"]);
    expect(json.missing).toEqual(["ghost.md"]);
  });

  it("skips dot-directories but still captures _agent/ markdown", async () => {
    await seed("_agent/now.md", HEALTHY);
    await seed(".claude/notes.md", HEALTHY);
    const exit = await writeCommand.run(["."], {}, G);
    expect(exit).toBe(0);
    const staged = git(["diff", "--cached", "--name-only"]).split("\n");
    expect(staged).toContain("_agent/now.md");
    expect(staged).not.toContain(".claude/notes.md");
  });

  it("--stage=false checks health without staging", async () => {
    await seed("notes/a.md", HEALTHY);
    const exit = await writeCommand.run(["notes"], { stage: "false" }, G);
    expect(exit).toBe(0);
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
  });

  it("errors when no .md files are found", async () => {
    await fs.mkdir(join(tmp, "empty"), { recursive: true });
    const exit = await writeCommand.run(["empty"], {}, G);
    expect(exit).toBe(1);
  });

  it("a lone existing file authors (composes frontmatter), not batch-stage", async () => {
    await seed("solo.md", HEALTHY);
    // Author mode honors --content/--force and replaces frontmatter wholesale;
    // batch mode would ignore them and stage the file as-is.
    const exit = await writeCommand.run(
      ["solo.md"],
      { content: "# Solo\nbody", name: "Solo", force: true },
      G,
    );
    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "solo.md"), "utf-8");
    expect(written).toContain("name: Solo");
    expect(written).toContain("# Solo");
    expect(written).not.toContain("summary: about a"); // old frontmatter replaced
  });
});
