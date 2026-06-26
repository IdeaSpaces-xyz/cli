import { describe, expect, it } from "vitest";
import { searchDocs, tokenize, type SearchDoc } from "../search.js";

const docs = (entries: Array<[string, string]>): SearchDoc[] =>
  entries.map(([path, content]) => ({ path, content }));

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric, breaking hyphenated tokens", () => {
    expect(tokenize("Multi-Agent  Awareness, v2")).toEqual([
      "multi",
      "agent",
      "awareness",
      "v2",
    ]);
  });

  it("returns [] for punctuation-only / empty input", () => {
    expect(tokenize("  —  ")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("searchDocs", () => {
  it("returns nothing for an empty query or empty corpus", () => {
    expect(searchDocs(docs([["a.md", "hello"]]), "   ")).toEqual([]);
    expect(searchDocs(docs([]), "hello")).toEqual([]);
  });

  it("ranks a body match and reports its snippet + line", () => {
    const r = searchDocs(
      docs([
        ["a.md", "nothing here\nthe awareness loop closes\nmore"],
        ["b.md", "unrelated text"],
      ]),
      "awareness",
    );
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("a.md");
    expect(r[0].body_hits).toBe(1);
    expect(r[0].snippet).toBe("the awareness loop closes");
    expect(r[0].line).toBe(2);
  });

  it("surfaces a filename-only match (no body hit) and ranks it above a weak body mention", () => {
    const r = searchDocs(
      docs([
        ["notes/awareness.md", "this file never says the word in its body"],
        ["other.md", "a passing awareness, once"],
      ]),
      "awareness",
    );
    expect(r.map((x) => x.path)).toEqual(["notes/awareness.md", "other.md"]);
    const titleHit = r.find((x) => x.path === "notes/awareness.md")!;
    expect(titleHit.name_hits).toBe(1);
    expect(titleHit.body_hits).toBe(0);
    expect(titleHit.line).toBeNull();
  });

  it("rewards term frequency — a doc mentioning the term more scores higher", () => {
    const r = searchDocs(
      docs([
        ["dense.md", "sync sync sync everywhere"],
        ["sparse.md", "sync mentioned once here, plus filler filler filler"],
      ]),
      "sync",
    );
    expect(r[0].path).toBe("dense.md");
  });

  it("honours the limit", () => {
    const r = searchDocs(
      docs([
        ["a.md", "match"],
        ["b.md", "match"],
        ["c.md", "match"],
      ]),
      "match",
      2,
    );
    expect(r).toHaveLength(2);
  });

  it("combines body + filename signals over multiple terms", () => {
    const r = searchDocs(
      docs([
        ["state-and-location.md", "the design covers state across the device"],
        ["misc.md", "state appears but the file is named otherwise"],
      ]),
      "state location",
    );
    // First doc carries both terms in its name ('state', 'location') plus a
    // body hit on 'state' → it clearly leads the bare body mention in misc.md.
    expect(r[0].path).toBe("state-and-location.md");
    expect(r[0].name_hits).toBe(2);
  });
});
