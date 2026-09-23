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

  it("preserves thread:x_... addresses and opaque revision in Map selections", () => {
    const threadSelection = {
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
            address: "thread:x_0123456789abcdef01234567",
            depth: "summary",
            name: "Ongoing Thread",
            revision: "n_fedcba9876543210fedcba98",
            disclosure: { name: "Coordination", summary: "Latest discussion on topic." },
          },
        ],
      },
    };

    const parsed = parseExchangeMapSelection(threadSelection);
    expect(parsed.map.members[1]).toEqual(threadSelection.map.members[1]);
    const formatted = formatPortableMap(parsed.map).join("\n");
    expect(formatted).toContain("thread:x_0123456789abcdef01234567@n_fedcba9876543210fedcba98 · ceiling=summary");
    expect(formatted).toContain("observed name=\"Coordination\"");
    expect(formatted).toContain("curated name=\"Ongoing Thread\"");
  });

  it("supports thread:x_... without revision and preserves hostname: compatibility", () => {
    const threadNoRev = {
      kind: "exchange-map-selection",
      target_node_id: "n_abcdefabcdefabcdefabcdef",
      map: {
        roots: [],
        members: [
          {
            address: "thread:x_0123456789abcdef01234567",
            depth: "summary",
            name: "Thread without revision",
            disclosure: {},
          },
          {
            address: "thread:x_0123456789ab",
            depth: "name",
            revision: "n_0123456789ab",
            disclosure: {},
          },
          {
            address: "hostname:example.org",
            depth: "name",
            name: "Hostname entity",
            disclosure: { name: "Example" },
          },
        ],
      },
    };

    const parsed = parseExchangeMapSelection(threadNoRev);
    expect(parsed.map.members[0]?.address).toBe("thread:x_0123456789abcdef01234567");
    expect(parsed.map.members[0]).not.toHaveProperty("revision");
    expect(parsed.map.members[1]?.address).toBe("thread:x_0123456789ab");
    expect(parsed.map.members[1]?.revision).toBe("n_0123456789ab");
    expect(parsed.map.members[2]?.address).toBe("hostname:example.org");
    const formatted = formatPortableMap(parsed.map).join("\n");
    expect(formatted).toContain("[0] thread:x_0123456789abcdef01234567 · ceiling=summary");
    expect(formatted).toContain("[1] thread:x_0123456789ab@n_0123456789ab · ceiling=name");
    expect(formatted).toContain("[2] hostname:example.org · ceiling=name");
  });

  it("refuses invalid thread addresses and malformed revisions", () => {
    const invalidAddress = {
      kind: "exchange-map-selection",
      target_node_id: "n_abcdefabcdefabcdefabcdef",
      map: {
        roots: [],
        members: [{ address: "thread:not_hex", disclosure: {} }],
      },
    };
    expect(() => parseExchangeMapSelection(invalidAddress)).toThrow(
      "Map member 0 address must be a canonical hostname: or thread:x_<24hex>",
    );

    const invalidRevision = {
      kind: "exchange-map-selection",
      target_node_id: "n_abcdefabcdefabcdefabcdef",
      map: {
        roots: [],
        members: [
          {
            address: "thread:x_0123456789abcdef01234567",
            revision: "invalid_note_id",
            disclosure: {},
          },
        ],
      },
    };
    expect(() => parseExchangeMapSelection(invalidRevision)).toThrow(
      "Map member 0 revision must be a valid note ID (n_<24hex> or n_<12hex>)",
    );
  });
});
