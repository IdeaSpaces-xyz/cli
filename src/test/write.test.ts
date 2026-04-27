import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCommand } from "../commands/write.js";
import type { GlobalFlags } from "../types.js";

const baseGlobal: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-write-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("ideaspaces write", () => {
  it("creates a new file with Layer 1 frontmatter", async () => {
    const exit = await writeCommand.run(
      ["notes/foo.md"],
      { content: "# Foo\nBody.", name: "Foo", summary: "About foo." },
      baseGlobal,
    );
    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "notes/foo.md"), "utf-8");
    expect(written).toContain("---\nname: Foo\nsummary: About foo.\n---\n");
    expect(written).toContain("# Foo\nBody.");
  });

  it("composes tags and attached_to into the frontmatter", async () => {
    const exit = await writeCommand.run(
      ["notes/foo.md"],
      {
        content: "# Foo",
        name: "Foo",
        tags: "research,architecture",
        "attached-to": "person:alice,hostname:acme.com",
      },
      baseGlobal,
    );
    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "notes/foo.md"), "utf-8");
    expect(written).toContain("tags:\n  - research\n  - architecture");
    expect(written).toContain("attached_to:\n  - person:alice\n  - hostname:acme.com");
  });

  it("refuses to overwrite without --force", async () => {
    await fs.writeFile(join(tmp, "existing.md"), "# Original", "utf-8");
    const exit = await writeCommand.run(
      ["existing.md"],
      { content: "# New" },
      baseGlobal,
    );
    expect(exit).toBe(5);
    expect((await fs.readFile(join(tmp, "existing.md"), "utf-8")).trim()).toBe("# Original");
  });

  it("overwrites with --force", async () => {
    await fs.writeFile(join(tmp, "existing.md"), "# Original", "utf-8");
    const exit = await writeCommand.run(
      ["existing.md"],
      { content: "# New", name: "New", force: true },
      baseGlobal,
    );
    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "existing.md"), "utf-8");
    expect(written).toContain("name: New");
    expect(written).toContain("# New");
  });

  it("strips a body's leading frontmatter (replace-semantics)", async () => {
    const exit = await writeCommand.run(
      ["notes/foo.md"],
      {
        content: "---\nname: OldName\n---\n# Body\nReal content.",
        name: "NewName",
      },
      baseGlobal,
    );
    expect(exit).toBe(0);
    const written = await fs.readFile(join(tmp, "notes/foo.md"), "utf-8");
    expect(written).toContain("name: NewName");
    expect(written).not.toContain("OldName");
    expect(written).toContain("# Body\nReal content.");
  });

  it("creates parent directories", async () => {
    const exit = await writeCommand.run(
      ["a/b/c/deep.md"],
      { content: "# Deep" },
      baseGlobal,
    );
    expect(exit).toBe(0);
    expect(existsSync(join(tmp, "a/b/c/deep.md"))).toBe(true);
  });

  it("fails when no content is provided", async () => {
    // Force isTTY=true so readStdin returns "" instead of blocking on piped input.
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const exit = await writeCommand.run(["foo.md"], {}, baseGlobal);
      expect(exit).toBe(1);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
    }
  });
});
