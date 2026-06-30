import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTimes } from "../git.js";

let tmp: string;

function git(args: string[], epochSec?: number): void {
  const env = epochSec
    ? { ...process.env, GIT_AUTHOR_DATE: `${epochSec} +0000`, GIT_COMMITTER_DATE: `${epochSec} +0000` }
    : process.env;
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function commitAt(file: string, content: string, epochSec: number): Promise<void> {
  await fs.writeFile(join(tmp, file), content, "utf-8");
  git(["add", file]);
  git(["commit", "-q", "-m", `edit ${file}`], epochSec);
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-times-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const T1 = 1_700_000_000;
const T2 = 1_700_001_000;
const T3 = 1_700_002_000;

describe("fileTimes", () => {
  it("reports git first-commit (created) and last-commit (updated) per note, in ms", async () => {
    await commitAt("a.md", "one", T1); // a created
    await commitAt("a.md", "two", T2); // a updated
    await commitAt("b.md", "b", T3); // b created == updated

    const times = fileTimes(tmp);
    const byPath = Object.fromEntries(times.map((f) => [f.path, f]));

    expect(byPath["a.md"]).toEqual({ path: "a.md", created_at: T1 * 1000, updated_at: T2 * 1000 });
    expect(byPath["b.md"]).toEqual({ path: "b.md", created_at: T3 * 1000, updated_at: T3 * 1000 });
  });

  it("ignores non-markdown files", async () => {
    await commitAt("note.md", "n", T1);
    await fs.writeFile(join(tmp, "image.png"), "binary", "utf-8");
    git(["add", "image.png"]);
    git(["commit", "-q", "-m", "img"], T2);

    const paths = fileTimes(tmp).map((f) => f.path);
    expect(paths).toContain("note.md");
    expect(paths).not.toContain("image.png");
  });

  it("returns [] outside a git repo", async () => {
    const nonRepo = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-norepo-")));
    expect(fileTimes(nonRepo)).toEqual([]);
    await rm(nonRepo, { recursive: true, force: true });
  });
});
