import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasIdentityProblems,
  renderIdentityProblems,
  scanMarkdownIdentityFiles,
} from "../identity-report.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-identity-report-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function md(nodeId: string, body = "# Note"): string {
  return `---\nname: Test\nnode_id: ${nodeId}\n---\n\n${body}\n`;
}

describe("identity report", () => {
  it("renders missing identities", async () => {
    const missing = join(tmp, "missing.md");
    await writeFile(missing, "# Missing identity\n", "utf-8");

    const scan = await scanMarkdownIdentityFiles([missing]);
    expect(hasIdentityProblems(scan)).toBe(true);
    expect(renderIdentityProblems(scan, { cwd: tmp })).toBe("Missing node_id (1):\n  missing.md");
  });

  it("renders malformed and duplicate identities with header/footer spacing", async () => {
    const malformed = join(tmp, "bad.md");
    const dupA = join(tmp, "a.md");
    const dupB = join(tmp, "b.md");
    await writeFile(malformed, "---\nnode_id: nope\n---\n# Bad\n", "utf-8");
    await writeFile(dupA, md("n_abcdef123456abcdef123456"), "utf-8");
    await writeFile(dupB, md("n_abcdef123456abcdef123456"), "utf-8");

    const scan = await scanMarkdownIdentityFiles([malformed, dupA, dupB]);
    expect(hasIdentityProblems(scan)).toBe(true);

    const report = renderIdentityProblems(scan, {
      cwd: tmp,
      header: ["Header", ""],
      footer: ["Footer"],
    });

    expect(report).toContain("Header\n\nMalformed node_id (1):");
    expect(report).toContain("  bad.md — ");
    expect(report).toContain("Duplicate node_id (2 files):\n  n_abcdef123456abcdef123456\n    a.md\n    b.md");
    expect(report).toContain("\n\nFooter");
    expect(report).not.toContain("\n\n\n");
  });

  it("reports no problems for valid unique identities", async () => {
    const one = join(tmp, "one.md");
    const two = join(tmp, "two.md");
    await writeFile(one, md("n_111111111111111111111111"), "utf-8");
    await writeFile(two, md("n_222222222222222222222222"), "utf-8");

    const scan = await scanMarkdownIdentityFiles([one, two]);
    expect(hasIdentityProblems(scan)).toBe(false);
    expect(renderIdentityProblems(scan)).toBe("");
  });
});
