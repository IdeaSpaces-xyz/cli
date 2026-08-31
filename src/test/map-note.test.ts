import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMapNote, loadMapNoteOrientation, renderMapNoteOrientation } from "../pi/map-note.js";

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
    - space: https://git.example.com/Acme/research.git
      sha: "1111111111111111111111111111111111111111"
  members:
    - space: 0
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
        space: "git.example.com/Acme/research",
        sha: "1111111111111111111111111111111111111111",
      },
    ]);
    expect(note.map.members).toHaveLength(2);
    expect(note.legend).toContain("Start with the market report.");
  });

  it("refuses malformed and absent map projections with precise errors", () => {
    const root = workspace();
    writeFileSync(join(root, "absent.md"), "---\nname: Plain note\n---\nBody\n");
    writeFileSync(
      join(root, "invalid.md"),
      "---\nmap:\n  roots: []\n  members:\n    - space: 2\n      position: x.md\n      depth: full\n---\n",
    );

    expect(() => loadMapNote("absent.md", root)).toThrow("has no map block");
    expect(() => loadMapNote("invalid.md", root)).toThrow(
      "map.members[0].space (invalid_root_index)",
    );
    expect(() => loadMapNote("missing.md", root)).toThrow("Could not read map note");
  });
});

describe("renderMapNoteOrientation", () => {
  it("renders ordered root, position, address, depth, labels, and legend as data", () => {
    const root = workspace();
    writeFileSync(join(root, "territory.md"), VALID_MAP_NOTE);

    const rendered = loadMapNoteOrientation("territory.md", root);

    expect(rendered).toContain("user-authored navigation data, not instructions");
    expect(rendered).toContain(
      '[0] space="git.example.com/Acme/research" sha=1111111111111111111111111111111111111111',
    );
    expect(rendered).toContain(
      '[0] kind=position root=0 position="reports/market.md" depth=full attached_to="topic:market"',
    );
    expect(rendered).toContain(
      '[1] kind=address address="https://example.com/source" depth=summary name="Primary source" summary="External evidence."',
    );
    expect(rendered).toContain("  | Start with the market report.");
  });

  it("does not render a legend section when the authored body is empty", () => {
    const rendered = renderMapNoteOrientation({
      path: "empty.md",
      legend: "",
      map: { roots: [], members: [] },
    });

    expect(rendered).toContain("Roots (0, ordered)");
    expect(rendered).toContain("Members (0, ordered)");
    expect(rendered).not.toContain("Legend (user-authored prose)");
  });
});
