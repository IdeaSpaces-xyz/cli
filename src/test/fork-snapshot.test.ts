import { describe, expect, it } from "vitest";
import { prepareForkSnapshot } from "../fork-snapshot.js";

const HEAD = "a".repeat(40);
const FOUNDATION_ID = "n_111111111111111111111111";

function md(nodeId: string, body = "Body"): string {
  return `---\nnode_id: ${nodeId}\n---\n${body}\n`;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const files = [
    { path: "_agent/foundation.md", content: md(FOUNDATION_ID, "Foundation") },
    { path: "README.md", content: md("n_222222222222222222222222", "Read me") },
  ];
  return {
    source_head: HEAD,
    markdown_file_count: files.length,
    markdown_bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    files,
    asset_file_count: 1,
    asset_bytes: 7,
    assets: [{ path: "docs/_assets/picture.png", content_base64: "cGF5bG9hZA==" }],
    ...overrides,
  };
}

describe("public Fork snapshot validation", () => {
  it("accepts the complete bounded Markdown and supporting-payload envelope", () => {
    const result = prepareForkSnapshot(snapshot());

    expect(result.sourceHead).toBe(HEAD);
    expect(Object.keys(result.markdown)).toEqual(["_agent/foundation.md", "README.md"]);
    expect(result.assets).toEqual([
      { path: "docs/_assets/picture.png", content: Buffer.from("payload") },
    ]);
  });

  it.each([
    "../outside.md",
    "/absolute.md",
    "a\\b.md",
    "a//b.md",
    ".git/config.md",
    "notes/CON.md",
    "notes/trailing.md ",
  ])("rejects unsafe Markdown path %s", (path) => {
    const files = [{ path, content: md(FOUNDATION_ID) }];
    expect(() =>
      prepareForkSnapshot(snapshot({ files, markdown_file_count: 1 })),
    ).toThrow(/path/i);
  });

  it("requires payload beneath exact _assets/ with infrastructure precedence", () => {
    expect(() =>
      prepareForkSnapshot(
        snapshot({ assets: [{ path: "_agent/_assets/private.png", content_base64: "" }], asset_bytes: 0 }),
      ),
    ).toThrow(/outside exact _assets/);
    expect(() =>
      prepareForkSnapshot(
        snapshot({ assets: [{ path: "docs/Assets/picture.png", content_base64: "" }], asset_bytes: 0 }),
      ),
    ).toThrow(/outside exact _assets/);
  });

  it("rejects duplicate, case-colliding, and file-prefix paths", () => {
    const duplicate = snapshot({
      files: [
        { path: "README.md", content: md(FOUNDATION_ID) },
        { path: "readme.md", content: md("n_222222222222222222222222") },
      ],
      markdown_file_count: 2,
    });
    expect(() => prepareForkSnapshot(duplicate)).toThrow(/collide/);

    const prefix = snapshot({
      files: [{ path: "docs.md", content: md(FOUNDATION_ID) }],
      markdown_file_count: 1,
      assets: [{ path: "docs.md/_assets/picture.png", content_base64: "" }],
      asset_bytes: 0,
    });
    expect(() => prepareForkSnapshot(prefix)).toThrow(/file\/directory/);
  });

  it("rejects duplicate Note ids and malformed base64 before materialization", () => {
    const duplicateIds = snapshot({
      files: [
        { path: "_agent/foundation.md", content: md(FOUNDATION_ID) },
        { path: "README.md", content: md(FOUNDATION_ID) },
      ],
    });
    expect(() => prepareForkSnapshot(duplicateIds)).toThrow(/duplicate node_id/);

    expect(() =>
      prepareForkSnapshot(
        snapshot({ assets: [{ path: "_assets/picture.png", content_base64: "not base64" }] }),
      ),
    ).toThrow(/base64/);
  });

  it("requires exact counts and decoded asset bytes", () => {
    expect(() => prepareForkSnapshot(snapshot({ markdown_file_count: 1 }))).toThrow(/envelope/);
    expect(() => prepareForkSnapshot(snapshot({ asset_file_count: 2 }))).toThrow(/envelope/);
    expect(() => prepareForkSnapshot(snapshot({ asset_bytes: 8 }))).toThrow(/byte count/);
  });
});
