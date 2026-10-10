import { describe, it, expect } from "vitest";
import { parseArgs } from "../argv.js";

describe("parseArgs", () => {
  it("parses --repo=value as a global flag", () => {
    const parsed = parseArgs(["--repo=acme/notes", "navigate"]);
    expect(parsed.global.repo).toBe("acme/notes");
    expect(parsed.command).toBe("navigate");
  });

  it("parses --repo value as a global flag", () => {
    const parsed = parseArgs(["--repo", "acme/notes", "navigate"]);
    expect(parsed.global.repo).toBe("acme/notes");
    expect(parsed.command).toBe("navigate");
  });

  it("keeps command flags in flags object", () => {
    const parsed = parseArgs(["search", "auth", "--limit=5", "--scope", "core/"]);
    expect(parsed.command).toBe("search");
    expect(parsed.args).toEqual(["auth"]);
    expect(parsed.flags.limit).toBe("5");
    expect(parsed.flags.scope).toBe("core/");
  });

  it("supports boolean globals with equals syntax", () => {
    const parsed = parseArgs(["--json=true", "--quiet=false", "power", "repos"]);
    expect(parsed.global.json).toBe(true);
    expect(parsed.global.quiet).toBe(false);
    expect(parsed.command).toBe("power");
    expect(parsed.args).toEqual(["repos"]);
  });

  it("parses a single-letter short flag with a value (-m), leaving paths positional", () => {
    const parsed = parseArgs(["commit", "-m", "my message", "notes/a.md", "notes/b.md"]);
    expect(parsed.command).toBe("commit");
    expect(parsed.flags.m).toBe("my message");
    expect(parsed.args).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("keeps a positional after --read-only and accepts a leading-dash message via equals", () => {
    const parsed = parseArgs(["agent", "run", "--read-only", "./other-pov", "--message=--inspect"]);
    expect(parsed.args).toEqual(["run", "./other-pov"]);
    expect(parsed.flags).toMatchObject({ "read-only": true, message: "--inspect" });
    expect(parseArgs(["conversation", "send", "--read-only", "--message=hi"]).flags["read-only"]).toBe(true);
    expect(parseArgs(["--read-only", "agent", "run", "./pov"]).args).toEqual(["run", "./pov"]);
  });

  it("treats a short flag with no following value as boolean", () => {
    const parsed = parseArgs(["sync", "-n"]);
    expect(parsed.flags.n).toBe(true);
  });

  it("accumulates only --reach; leaves --ext and --skill last-wins", () => {
    const spaceSeparated = parseArgs(["agent", "run", "scout", "--message", "hi", "--reach", "/dir1", "--reach", "/dir2"]);
    expect(spaceSeparated.flags.reach).toEqual(["/dir1", "/dir2"]);

    const equalsSeparated = parseArgs(["agent", "run", "scout", "--message=hi", "--reach=/dir1", "--reach=/dir2"]);
    expect(equalsSeparated.flags.reach).toEqual(["/dir1", "/dir2"]);
    expect(parseArgs(["agent", "run", "scout", "--reach", "/dir,one", "--reach", "/dir,two"]).flags.reach)
      .toEqual(["/dir,one", "/dir,two"]);
    expect(parseArgs(["agent", "run", "scout", "--reach", "/dir", "--reach"]).flags.reach).toBe(true);
    expect(parseArgs(["agent", "run", "scout", "--ext", "a", "--ext", "b", "--skill=x", "--skill=y"]).flags)
      .toMatchObject({ ext: "b", skill: "y" });
  });

  it("preserves last-wins semantics for non-repeatable flags", () => {
    const parsed = parseArgs(["agent", "run", "scout", "--message", "first", "--message", "second"]);
    expect(parsed.flags.message).toBe("second");
  });

  it("parses --git-bin flag to absolute path without mutating process.env", () => {
    const parsed = parseArgs(["status", "doctor", "--git-bin", "custom/git"]);
    expect(parsed.global.gitBin).toMatch(/[/\\]custom[/\\]git$/);

    const eqParsed = parseArgs(["status", "doctor", "--git-bin=/custom/git2"]);
    expect(eqParsed.global.gitBin).toBe("/custom/git2");

    const bareParsed = parseArgs(["status", "doctor", "--git-bin", "git"]);
    expect(bareParsed.global.gitBin).toBe("git");
  });

  it("throws when --git-bin is missing a path argument", () => {
    expect(() => parseArgs(["status", "doctor", "--git-bin"])).toThrow(/--git-bin requires a path argument/);
    expect(() => parseArgs(["status", "doctor", "--git-bin", "--json"])).toThrow(/--git-bin requires a path argument/);
    expect(() => parseArgs(["status", "doctor", "--git-bin="])).toThrow(/--git-bin requires a path argument/);
  });
});
