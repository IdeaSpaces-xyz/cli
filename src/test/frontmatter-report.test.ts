import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderFrontmatterSyntaxProblems,
  scanMarkdownFrontmatterSyntaxFiles,
} from "../frontmatter-report.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-frontmatter-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("frontmatter-report", () => {
  it("reports no frontmatter as none", async () => {
    const path = join(tmp, "plain.md");
    await writeFile(path, "# Plain\n", "utf-8");

    const scan = await scanMarkdownFrontmatterSyntaxFiles([path]);

    expect(scan.files[0]).toMatchObject({ path, status: "none" });
    expect(scan.malformed).toEqual([]);
  });

  it("reports plain valid frontmatter", async () => {
    const path = join(tmp, "valid.md");
    await writeFile(path, "---\nname: Foo\n---\n# Foo\n", "utf-8");

    const scan = await scanMarkdownFrontmatterSyntaxFiles([path]);

    expect(scan.files[0]).toMatchObject({ path, status: "valid" });
    expect(scan.malformed).toEqual([]);
  });

  it("reports unclosed frontmatter", async () => {
    const path = join(tmp, "unclosed.md");
    await writeFile(path, "---\nname: Foo\n# Foo\n", "utf-8");

    const scan = await scanMarkdownFrontmatterSyntaxFiles([path]);

    expect(scan.malformed[0]).toMatchObject({
      path,
      status: "malformed",
      message: "frontmatter block is missing closing ---",
      line: 1,
      column: 1,
    });
  });

  it("reports malformed leading-backtick frontmatter with line and column", async () => {
    const path = join(tmp, "bad.md");
    await writeFile(path, "---\nname: `bad`\n---\n# Bad\n", "utf-8");

    const scan = await scanMarkdownFrontmatterSyntaxFiles([path]);

    expect(scan.malformed[0]).toMatchObject({ path, status: "malformed", line: 2, column: 7 });
  });

  it("handles CRLF frontmatter", async () => {
    const path = join(tmp, "crlf.md");
    await writeFile(path, "---\r\nname: Foo\r\n---\r\n# Foo\r\n", "utf-8");

    const scan = await scanMarkdownFrontmatterSyntaxFiles([path]);

    expect(scan.files[0]).toMatchObject({ path, status: "valid" });
    expect(scan.malformed).toEqual([]);
  });

  it("renders footer without duplicate blank lines", () => {
    const rendered = renderFrontmatterSyntaxProblems(
      {
        files: [],
        malformed: [
          {
            path: join(tmp, "bad.md"),
            status: "malformed",
            message: "bad yaml",
          },
        ],
      },
      { cwd: tmp, footer: ["Fix YAML first."] },
    );

    expect(rendered).toContain("Malformed frontmatter (1):\n  bad.md\n    bad yaml\n\nFix YAML first.");
  });
});
