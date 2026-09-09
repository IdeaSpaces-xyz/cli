import { describe, expect, it } from "vitest";

import { formatPortableMap, parseExchangeMapSelection } from "../exchange-map-selection.js";

const ROOT = "n_0123456789abcdef01234567";
const SHA = "a".repeat(40);

function selection() {
  return {
    kind: "exchange-map-selection",
    target_node_id: "n_abcdefabcdefabcdefabcdef",
    map: {
      roots: [{ repo: `https://ideaspaces.xyz/repos/${ROOT}`, root_node_id: ROOT, sha: SHA }],
      members: [
        {
          root: 0,
          position: "notes/finding.md",
          depth: "surface",
          name: "Why this one",
          disclosure: { name: "Finding", summary: "Observed at the pin." },
        },
        {
          address: "hostname:example.com",
          depth: "summary",
          summary: "The entity in question",
          disclosure: { name: "Example", summary: "Current when selected." },
        },
      ],
    },
  };
}

describe("exchange Map selections", () => {
  it("preserves ordered references, observed disclosure, and curator annotations", () => {
    const parsed = parseExchangeMapSelection(selection());

    expect(parsed.map.members).toEqual(selection().map.members);
    expect(formatPortableMap(parsed.map).join("\n")).toContain("ceiling=surface");
    expect(formatPortableMap(parsed.map).join("\n")).toContain("observed name=\"Finding\"");
    expect(formatPortableMap(parsed.map).join("\n")).toContain("curated name=\"Why this one\"");
  });

  it("refuses private bindings and unsupported transport fields", () => {
    const value = selection();
    (value.map.roots[0] as Record<string, unknown>).local_path = "/private/checkout";

    expect(() => parseExchangeMapSelection(value)).toThrow(
      "Map root 0 contains unsupported fields: local_path",
    );
  });

  it("refuses malformed targets and protocol Maps", () => {
    expect(() => parseExchangeMapSelection({ ...selection(), target_node_id: "not-a-node" }))
      .toThrow("target_node_id is invalid");
    const value = selection();
    value.map.members[0] = { ...value.map.members[0], position: "../secret.md" };
    expect(() => parseExchangeMapSelection(value)).toThrow("invalid_position");
  });
});
