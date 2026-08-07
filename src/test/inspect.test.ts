import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCommand } from "../commands/inspect.js";
import type { GlobalFlags } from "../types.js";

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { ...JSON_GLOBAL, json: false };
const ACME_MARKDOWN = `---
name: Acme priorities
summary: Acme is preparing the next customer review.
---
# Acme priorities

OVERVIEW_BODY_SENTINEL

## Current priority

Ship the synthetic inspection fixture.

### Checks

SECTION_CHECK_SENTINEL

## Later

LATER_BODY_SENTINEL

## Review

First review.

## Review

Second review.
`;

let dir: string;
let path: string;

async function run(
  args: string[],
  flags: Record<string, string | boolean> = {},
  global: GlobalFlags = JSON_GLOBAL,
): Promise<{ exit: number; stdout: string; stderr: string; json: any }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await inspectCommand.run(args, flags, global);
    const text = stdout.join("");
    return {
      exit,
      stdout: text,
      stderr: stderr.join(""),
      json: global.json && text ? JSON.parse(text) : null,
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "is-cli-inspect-acme-"));
  path = join(dir, "Next.md");
  await writeFile(path, ACME_MARKDOWN);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ideaspaces inspect", () => {
  it("defaults to the summary rung without disclosing the document body", async () => {
    const result = await run([path]);

    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({
      path,
      mode: "summary",
      summary: "Acme is preparing the next customer review.",
      truncation: { truncated: false },
    });
    expect(result.stdout).not.toContain("OVERVIEW_BODY_SENTINEL");
    expect(result.stdout).not.toContain("SECTION_CHECK_SENTINEL");

    const human = await run([path], {}, HUMAN_GLOBAL);
    expect(human.stdout).toBe("Acme is preparing the next customer review.\n");
  });

  it("returns an ATX outline without section bodies in text and JSON", async () => {
    const result = await run([path], { mode: "outline" });

    expect(result.exit).toBe(0);
    expect(result.json.mode).toBe("outline");
    expect(result.json.headings.map((heading: { text: string }) => heading.text)).toEqual([
      "Acme priorities",
      "Current priority",
      "Checks",
      "Later",
      "Review",
      "Review",
    ]);
    expect(result.stdout).not.toContain("OVERVIEW_BODY_SENTINEL");
    expect(result.stdout).not.toContain("LATER_BODY_SENTINEL");

    const human = await run([path], { mode: "outline" }, HUMAN_GLOBAL);
    expect(human.stdout).toContain("## Current priority (line 9)");
    expect(human.stdout).toContain("## Review (line 25, occurrence 2)");
    expect(human.stdout).not.toContain("SECTION_CHECK_SENTINEL");
  });

  it("returns only the selected section and its nested subsections", async () => {
    const result = await run([path], {
      mode: "section",
      heading: "Current priority",
    });

    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({
      mode: "section",
      status: "found",
      heading: { text: "Current priority", occurrence: 1 },
    });
    expect(result.json.markdown).toContain("Ship the synthetic inspection fixture.");
    expect(result.json.markdown).toContain("SECTION_CHECK_SENTINEL");
    expect(result.json.markdown).not.toContain("LATER_BODY_SENTINEL");
    expect(result.json.markdown).not.toContain("OVERVIEW_BODY_SENTINEL");
  });

  it("requires an occurrence for duplicate exact headings", async () => {
    const ambiguous = await run([path], { mode: "section", heading: "Review" });
    expect(ambiguous.exit).toBe(1);
    expect(ambiguous.json).toMatchObject({
      mode: "section",
      status: "ambiguous",
      matches: [
        { text: "Review", occurrence: 1 },
        { text: "Review", occurrence: 2 },
      ],
    });

    const selected = await run([path], {
      mode: "section",
      heading: "Review",
      occurrence: "2",
    });
    expect(selected.exit).toBe(0);
    expect(selected.json.status).toBe("found");
    expect(selected.json.markdown).toContain("Second review.");
    expect(selected.json.markdown).not.toContain("First review.");
  });

  it("reports a missing exact heading without falling through to a body read", async () => {
    const result = await run([path], {
      mode: "section",
      heading: "Unknown priority",
    });
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({
      mode: "section",
      status: "not-found",
      query: { heading: "Unknown priority" },
      matches: [],
    });

    const human = await run(
      [path],
      { mode: "section", heading: "Unknown priority" },
      HUMAN_GLOBAL,
    );
    expect(human.exit).toBe(1);
    expect(human.stdout).toBe("Heading not found: Unknown priority\n");
    expect(human.stdout).not.toContain("OVERVIEW_BODY_SENTINEL");
  });

  it("bounds large section output at a UTF-8 boundary and reports omitted bytes", async () => {
    const large = join(dir, "Large.md");
    await writeFile(large, `# Large\n\n${"🙂".repeat(100)}\n`);

    const result = await run(
      [large],
      { mode: "section", heading: "Large", "max-bytes": "128" },
    );

    expect(result.exit).toBe(0);
    expect(result.json.truncation).toMatchObject({
      truncated: true,
      limitBytes: 128,
    });
    expect(result.json.truncation.returnedBytes).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(result.json.markdown, "utf8")).toBe(
      result.json.truncation.returnedBytes,
    );
    expect(`# Large\n\n${"🙂".repeat(100)}\n`.startsWith(result.json.markdown)).toBe(true);

    const human = await run(
      [large],
      { mode: "section", heading: "Large", "max-bytes": "128" },
      HUMAN_GLOBAL,
    );
    expect(human.stdout).toContain("[truncated: returned");
  });

  it("keeps outline truncation to a complete heading-record prefix", async () => {
    const many = join(dir, "Many.md");
    await writeFile(
      many,
      Array.from({ length: 40 }, (_, index) => `## Synthetic heading ${index}\n`).join(""),
    );

    const result = await run([many], { mode: "outline", "max-bytes": "128" });
    expect(result.exit).toBe(0);
    expect(result.json.truncation.truncated).toBe(true);
    expect(result.json.truncation.returnedBytes).toBeLessThanOrEqual(128);
    expect(result.json.headings.length).toBeGreaterThan(0);
    expect(result.json.headings.length).toBeLessThan(40);
  });

  it("validates mode-specific flags and local paths", async () => {
    const missingHeading = await run([path], { mode: "section" });
    expect(missingHeading.exit).toBe(1);
    expect(missingHeading.stderr).toContain("requires --heading");

    const wrongMode = await run([path], { mode: "body" });
    expect(wrongMode.exit).toBe(1);
    expect(wrongMode.stderr).toContain("summary, outline, or section");

    const invalidBound = await run([path], { "max-bytes": "unbounded" });
    expect(invalidBound.exit).toBe(1);
    expect(invalidBound.stderr).toContain("128 to 1048576");

    const tooSmall = await run([path], { "max-bytes": "127" });
    expect(tooSmall.exit).toBe(1);
    expect(tooSmall.stderr).toContain("128 to 1048576");

    const directory = await run([dir]);
    expect(directory.exit).toBe(1);
    expect(directory.stderr).toContain("Not a file");

    const missing = await run([join(dir, "missing.md")]);
    expect(missing.exit).toBe(1);
    expect(missing.stderr).toContain("No such file");
  });
});
