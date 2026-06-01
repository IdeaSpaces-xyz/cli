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

  it("treats a short flag with no following value as boolean", () => {
    const parsed = parseArgs(["sync", "-n"]);
    expect(parsed.flags.n).toBe(true);
  });
});
