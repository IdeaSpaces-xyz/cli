import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCommand } from "../commands/status.js";
import { navigateCommand } from "../commands/navigate.js";
import { whoamiCommand } from "../commands/whoami.js";
import { doctorCommand } from "../commands/doctor.js";
import { captureJson, captureStdout } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

const JSON_FLAGS: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_FLAGS: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function inDir<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(orig);
  }
}

let workspace: string;
let home: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "is-status-tail-")));
  home = join(workspace, "home");
  await mkdir(join(home, "_agent"), { recursive: true });
  await writeFile(join(home, "_agent", "foundation.md"), "---\nsummary: Home foundation.\n---\nBody\n");
  await writeFile(join(home, "_agent", "purpose.md"), "---\nsummary: Purpose.\n---\n");
  await writeFile(join(home, "_agent", "now.md"), "---\nsummary: Working on status.\n---\n");
  await writeFile(join(home, "README.md"), "# Home\n");
  git(home, ["init", "-q", "-b", "main"]);
  git(home, ["config", "user.email", "t@test"]);
  git(home, ["config", "user.name", "T"]);
  git(home, ["add", "."]);
  git(home, ["commit", "-qm", "seed"]);
  git(home, ["update-ref", "refs/ideaspaces/seen", "HEAD"]);
  // One commit since the last session, one staged capture, one loose file.
  await writeFile(join(home, "README.md"), "# Home v2\n");
  git(home, ["commit", "-qam", "revise"]);
  await writeFile(join(home, "note.md"), "# Note\n");
  git(home, ["add", "note.md"]);
  await writeFile(join(home, "loose.md"), "# Loose\n");

  const other = join(workspace, "other");
  await mkdir(other);
  await writeFile(join(other, "README.md"), "Other repo\n");
  git(other, ["init", "-q", "-b", "main"]);
  git(other, ["add", "."]);
  git(other, ["-c", "user.email=t@test", "-c", "user.name=T", "commit", "-qm", "x"]);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("status is the tail", () => {
  it("renders State, forest handles, and the manifest tail — nothing from the head", async () => {
    const { exit, out } = await inDir(home, () =>
      captureStdout(() => statusCommand.run([], { workspace }, TEXT_FLAGS)),
    );
    expect(exit).toBe(0);
    const text = out.trimEnd();
    expect(text.startsWith("State:\n  branch: main\n  remote: no upstream\n  working tree: dirty\n  captures awaiting commit: 1\n  untracked knowledge files: 1")).toBe(true);
    expect(text).toContain("Repos in scope (local):");
    expect(text).toContain("home — Working on status.");
    expect(text).toContain("Since last session (1 changes):");
    expect(text).toContain("M\tREADME.md");
    // State supersedes the compact Git line; head sections never appear.
    expect(text).not.toContain("Git: branch");
    expect(text).not.toContain("Position:");
    expect(text).not.toContain("Agent context:");
    expect(text).not.toContain("Working set:");
    // The CLI is stateless about Changes.
    expect(text).not.toContain("Change open");
  });

  it("orders the tail exactly as navigate does after the head", async () => {
    const status = await inDir(home, () =>
      captureJson<{ text: string }>(() => statusCommand.run([], { workspace }, JSON_FLAGS)),
    );
    const nav = await inDir(home, () =>
      captureJson<{ text: string }>(() =>
        navigateCommand.run([], { workspace, "no-git": true }, JSON_FLAGS),
      ),
    );
    const catalogIdx = nav.json.text.indexOf("Repos in scope (local):");
    expect(catalogIdx).toBeGreaterThan(0);
    const stateEnd = status.json.text.indexOf("\n\n");
    expect(status.json.text.slice(0, stateEnd).startsWith("State:")).toBe(true);
    expect(status.json.text.slice(stateEnd + 2)).toBe(nav.json.text.slice(catalogIdx));
  });

  it("keeps the capture-state JSON fields and adds the rendered text", async () => {
    const { exit, json } = await inDir(home, () =>
      captureJson(() => statusCommand.run([], {}, JSON_FLAGS)),
    );
    expect(exit).toBe(0);
    expect(json.repoRoot).toBe(home);
    expect(json.branch).toBe("main");
    expect(json.dirty).toBe(true);
    expect(json.tracked_captures).toEqual(["note.md"]);
    expect(json.untracked_in_tracked_dirs).toEqual(["loose.md"]);
    expect(json.root_identity.state).toBeTruthy();
    expect(json.text.startsWith("State:")).toBe(true);
    expect(json.text).not.toContain("Repos in scope");
  });

  it("warns on an unreadable --workspace instead of rendering nothing", async () => {
    const { json } = await inDir(home, () =>
      captureJson<{ text: string }>(() =>
        statusCommand.run([], { workspace: join(workspace, "missing") }, JSON_FLAGS),
      ),
    );
    expect(json.text).toContain("⚠ --workspace is not a readable directory");
  });
});

describe("status sections", () => {
  it("status account is whoami", async () => {
    const section = await captureJson(() => statusCommand.run(["account"], {}, JSON_FLAGS));
    const legacy = await captureJson(() => whoamiCommand.run([], {}, JSON_FLAGS));
    expect(section.exit).toBe(legacy.exit);
    expect(section.json).toEqual(legacy.json);
  });

  it("status doctor is doctor", async () => {
    const section = await captureJson(() => statusCommand.run(["doctor"], {}, JSON_FLAGS));
    const legacy = await captureJson(() => doctorCommand.run([], {}, JSON_FLAGS));
    expect(section.exit).toBe(legacy.exit);
    expect(section.json).toEqual(legacy.json);
  });

  it("refuses an unknown section", async () => {
    let err = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
    try {
      const { exit } = await captureStdout(() => statusCommand.run(["bogus"], {}, JSON_FLAGS));
      expect(exit).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(err).toContain("Unknown status section: bogus");
  });
});
