import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMapNote } from "../local/map-note.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ideaspaces-map-launch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VALID_MAP_NOTE = `---
name: Research territory
summary: The ordered places that matter.
map:
  roots:
    - repo: https://ideaspaces.xyz/repos/n_0123456789abcdef01234567
      sha: "1111111111111111111111111111111111111111"
  members:
    - root: 0
      position: reports/market.md
      depth: full
      attached_to: topic:market
    - address: https://example.com/source
      name: Primary source
      summary: External evidence.
      depth: summary
---

# Legend

Start with the market report.
`;

describe("loadMapNote", () => {
  it("parses a map-note without resolving or cloning any listed root", () => {
    const root = workspace();
    writeFileSync(join(root, "territory.md"), VALID_MAP_NOTE);

    const note = loadMapNote("territory.md", root);

    expect(note.path).toBe("territory.md");
    expect(note.name).toBe("Research territory");
    expect(note.map.roots).toEqual([
      {
        repo: "https://ideaspaces.xyz/repos/n_0123456789abcdef01234567",
        root_node_id: "n_0123456789abcdef01234567",
        sha: "1111111111111111111111111111111111111111",
      },
    ]);
    expect(note.map.members).toHaveLength(2);
    expect(note.legend).toContain("Start with the market report.");
  });

  it("keeps an explicitly relative outside path relative in the orientation", () => {
    const root = workspace();
    const context = join(root, "context");
    mkdirSync(context);
    writeFileSync(join(root, "territory.md"), VALID_MAP_NOTE);

    expect(loadMapNote("../territory.md", context).path).toBe("../territory.md");
  });

  it("refuses malformed and absent map projections with precise errors", () => {
    const root = workspace();
    writeFileSync(join(root, "absent.md"), "---\nname: Plain note\n---\nBody\n");
    writeFileSync(
      join(root, "invalid.md"),
      "---\nmap:\n  roots: []\n  members:\n    - root: 2\n      position: x.md\n      depth: full\n---\n",
    );

    expect(() => loadMapNote("absent.md", root)).toThrow("has no map block");
    expect(() => loadMapNote("invalid.md", root)).toThrow(
      "map.members[0].root (invalid_root_index)",
    );
    expect(() => loadMapNote("missing.md", root)).toThrow("Could not read map note");
  });
});
