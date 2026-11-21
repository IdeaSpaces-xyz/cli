import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@ideaspaces/protocol";
import { threadsCommand } from "../commands/threads.js";
import { LINE_LIMIT, plainLine } from "../local/first-thread.js";

const ROOT_ID = "n_0123456789abcdef01234567";
const SCAFFOLD = "Home, this folder's own place. What it is for is not written yet. A prompt — the first\n  conversation asks, and the answers replace this line.";
const FIREFLY = "Keeps a public record of the 2. edition's promises — follows each source, writes every change on a timeline, and checks claims against sources one by one. Launched here, you are the Keeper.";
const temp: string[] = [];
const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

/** A place like one a person opens: a root Agreement, maybe a firefly, and Git with or without a name and email of its own. */
function place(summary: string, { firefly, identity = true, repo = true }: { firefly?: string; identity?: boolean; repo?: boolean } = {}): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "is-first-thread-"))); temp.push(dir);
  process.env.HOME = dir;
  process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global-gitconfig"); // only the repository's own identity counts here
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: Agreement — Home\nsummary: ${summary}\nroot_node_id: ${ROOT_ID}\n---\n# Home\n`);
  mkdirSync(join(dir, "agents", "a-notes"), { recursive: true }); // a plain folder first by name: not a firefly
  if (firefly) {
    mkdirSync(join(dir, "agents", "keeper", "_agent"), { recursive: true });
    writeFileSync(join(dir, "agents", "keeper", "_agent", "agreement.md"), `---\nname: Agreement — Keeper\nsummary: ${firefly}\nagreement: agent:repo:n_89abcdef0123456789abcdef\n---\n# Keeper\n`);
  }
  if (repo) {
    git(dir, "init", "-q", "-b", "main");
    if (identity) { git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test"); }
  }
  return dir;
}

async function inPlace(dir: string, args: string[], options: Record<string, string | boolean>): Promise<{ code: number; json: any; err: string }> {
  const before = process.cwd(); process.chdir(dir);
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = await threadsCommand.run(args, options, { json: true, quiet: false, yes: false, help: false });
    return { code, json: code === 0 && out ? JSON.parse(out) : undefined, err };
  } catch (error) {
    return { code: 1, json: undefined, err: err + (error instanceof Error ? error.message : String(error)) };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; process.chdir(before); }
}

const fields = (path: string) => parseFrontmatter(readFileSync(path, "utf8")) as Record<string, any>;
function opened(thread: string) {
  const post = readdirSync(thread).find((name) => name.endsWith(".md") && name !== "README.md")!;
  const text = readFileSync(join(thread, post), "utf8");
  return { readme: fields(join(thread, "README.md")), agreement: fields(join(thread, "_agent", "agreement.md")), post: fields(join(thread, post)), body: text.replace(/^---[\s\S]*?\n---\n/, "").trim() };
}

describe("a place's first Thread", () => {
  it("opens with one plain line from the place's Agreement: the opening post, the README and the Thread's Agreement say what it is for", async () => {
    const dir = place("Keeps the reading notes for the winter term. Everything else follows.");
    const { code, json } = await inPlace(dir, ["new", "2026-11-21-home-conversation"], { about: "Reading group" });
    expect(code).toBe(0);
    expect(json).toMatchObject({ summary: "Keeps the reading notes for the winter term.", summary_source: "agreement", summary_from: join(dir, "_agent", "agreement.md") });
    expect(json.warnings).toBeUndefined();
    const t = opened(json.path);
    expect(t.body).toBe("Keeps the reading notes for the winter term.");
    expect(t.post).toMatchObject({ name: "Reading group", summary: "Keeps the reading notes for the winter term." });
    expect(t.readme).toMatchObject({ name: "Reading group", summary: "Keeps the reading notes for the winter term." });
    expect(t.agreement).toMatchObject({ name: "Agreement — Reading group", summary: "Keeps the reading notes for the winter term." });
  });

  it("takes the firefly's line when the place's Agreement is still the scaffold's prompt, whole to its first sentence", async () => {
    const dir = place(SCAFFOLD, { firefly: FIREFLY });
    const { json } = await inPlace(dir, ["new", "2026-11-21-home-conversation"], { about: "Reading group" });
    const line = FIREFLY.slice(0, FIREFLY.indexOf(" Launched"));
    expect(json).toMatchObject({ summary: line, summary_source: "firefly", summary_from: join(dir, "agents", "keeper", "_agent", "agreement.md") });
    const t = opened(json.path);
    expect(t.body).toBe(line);
    expect(t.agreement.summary).toBe(line);
    expect(t.readme.summary).toBe(line);
  });

  it("falls back to the title, and a real Agreement summary, when nothing says what the place is for", async () => {
    const dir = place(SCAFFOLD);
    const { json } = await inPlace(dir, ["new", "first"], { about: "Reading group" });
    expect(json.summary_source).toBeUndefined();
    const t = opened(json.path);
    expect(t.body).toBe("Reading group");
    expect(t.agreement.summary).toBe('The Agreement of the Thread "Reading group": what it is for and what is agreed in it, kept as posts that are never edited.');
    expect(t.agreement.summary).not.toContain("Local Thread entry schema");
  });

  it("is only the first: a later Thread without --summary opens with its title, and --summary always wins", async () => {
    const dir = place("Keeps the reading notes for the winter term.");
    await inPlace(dir, ["new", "first"], { about: "Reading group" });
    const later = await inPlace(dir, ["new", "second"], { about: "Budget questions" });
    expect(later.json.summary_source).toBeUndefined();
    expect(opened(later.json.path).body).toBe("Budget questions");
    const given = await inPlace(dir, ["new", "third"], { about: "Sources", summary: "Which sources count, and why." });
    expect(given.json).toMatchObject({ summary: "Which sources count, and why.", summary_source: "flag" });
    expect(opened(given.json.path)).toMatchObject({ body: "Which sources count, and why.", agreement: { summary: "Which sources count, and why." }, readme: { summary: "Which sources count, and why." } });
  });

  it("refuses a --summary that isn't one line, and makes nothing", async () => {
    const dir = place("Keeps the reading notes.");
    for (const summary of ["two\nlines", "x".repeat(LINE_LIMIT + 1), "  ", true] as const) {
      const result = await inPlace(dir, ["new", "nope"], { about: "Nope", summary });
      expect(result.code).toBe(1);
      expect(result.err).toContain("--summary must be one line");
    }
    expect(existsSync(join(dir, "_threads", "nope"))).toBe(false);
  });

  it("says when Git can't commit posts here: no name and email of its own, or no repository", async () => {
    const none = place("Keeps the reading notes.", { identity: false });
    const result = await inPlace(none, ["new", "first"], { about: "Reading group" });
    expect(result.code).toBe(0);
    const words = "This repository's Git has no name and email, so its posts are written but not committed. Set them here: git config user.name \"Your Name\" and git config user.email you@example.com.";
    expect(result.json.warnings).toEqual([words]);
    expect(result.err).toContain(words);
    const bare = place("Keeps the reading notes.", { repo: false });
    expect((await inPlace(bare, ["new", "first"], { about: "Reading group" })).json.warnings).toEqual(["This folder is in no Git repository, so its posts are written but not committed. Run git init here to keep their history."]);
  });
});

describe("one plain line from a summary", () => {
  it("is the first sentence, never a prompt, and cut at a word past the limit", () => {
    expect(plainLine("One. Two.")).toBe("One.");
    expect(plainLine("Tracks the 2. edition's errata. Then more.")).toBe("Tracks the 2. edition's errata.");
    expect(plainLine("  spread\n  over lines  ")).toBe("spread over lines");
    expect(plainLine(SCAFFOLD)).toBeUndefined();
    expect(plainLine("")).toBeUndefined();
    expect(plainLine(7)).toBeUndefined();
    const long = plainLine(`${"word ".repeat(80)}end.`)!;
    expect([...long].length).toBeLessThanOrEqual(LINE_LIMIT);
    expect(long.endsWith("word…")).toBe(true);
  });
});
