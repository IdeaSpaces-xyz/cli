import { describe, expect, it } from "vitest";
import {
  acceptsFrontmatter, acceptsPath, frontmatterTags, frontmatterTextDecision, hasFilters,
  parseQuery, QueryError, wantsThreads,
} from "../search-query.js";
import { fold, tokenize } from "../search.js";

describe("Unicode tokens", () => {
  it("folds case and diacritics so Pēteris, peteris and PETERIS are one term", () => {
    expect(tokenize("Pēteris")).toEqual(["peteris"]);
    expect(tokenize("PĒTERIS un Jānis")).toEqual(["peteris", "un", "janis"]);
    expect(tokenize("peteris")).toEqual(["peteris"]);
  });

  it("keeps non-Latin letters whole and decomposes compatibility forms", () => {
    expect(tokenize("Привет, мир")).toEqual(["привет", "мир"]);
    expect(tokenize("ﬁle naïve café")).toEqual(["file", "naive", "cafe"]);
  });

  it("matches the ASCII fast path exactly", () => {
    expect(tokenize("Multi-Agent v2_x")).toEqual(["multi", "agent", "v2", "x"]);
    expect(fold("ABC")).toBe("abc");
  });
});

describe("parseQuery", () => {
  it("splits words from filters", () => {
    const q = parseQuery("loopback page tag:Onboarding in:agents/integrator/ kind:thread author:Scout");
    expect(q.terms).toEqual(["loopback", "page"]);
    expect(q.tags).toEqual([["onboarding"]]);
    expect(q.inPaths).toEqual(["agents/integrator"]);
    expect(q.kinds).toEqual(["thread_post", "thread_readme"]);
    expect(q.authors).toEqual(["scout"]);
    expect(hasFilters(q)).toBe(true);
    expect(wantsThreads(q)).toBe(true);
  });

  it("reads a comma as either and repeated tags as both", () => {
    expect(parseQuery("tag:auth,login").tags).toEqual([["auth", "login"]]);
    expect(parseQuery("tag:auth tag:#desktop").tags).toEqual([["auth"], ["desktop"]]);
  });

  it("negates words and every filter with a leading minus", () => {
    const q = parseQuery("plan -draft -tag:old -in:code -kind:post -author:bot");
    expect(q.terms).toEqual(["plan"]);
    expect(q.excludeTerms).toEqual(["draft"]);
    expect(q.excludeTags).toEqual(["old"]);
    expect(q.excludeIn).toEqual(["code"]);
    expect(q.excludeKinds).toEqual(["thread_post"]);
    expect(q.excludeAuthors).toEqual(["bot"]);
  });

  it("keeps quoted values whole and treats unknown keys as text", () => {
    expect(parseQuery('tag:"series a" note').tags).toEqual([["series a"]]);
    expect(parseQuery("https://example.com/page foo:bar").terms).toEqual(["https", "example", "com", "page", "foo", "bar"]);
  });

  it("refuses an empty value, an unknown kind, an escaping folder and an open quote, saying what to write", () => {
    expect(() => parseQuery("tag:")).toThrow(QueryError);
    expect(() => parseQuery("tag:")).toThrow(/tag:onboarding/);
    expect(() => parseQuery("kind:image")).toThrow(/note, thread, post, readme/);
    expect(() => parseQuery("in:../elsewhere")).toThrow(/inside the search/);
    expect(() => parseQuery('tag:"open')).toThrow(/quote/);
  });

  it("a word in both the query and its exclusions stays a query word", () => {
    const q = parseQuery("alpha -alpha -beta");
    expect(q.terms).toEqual(["alpha"]);
    expect(q.excludeTerms).toEqual(["beta"]);
  });
});

describe("filters", () => {
  it("in: matches whole folder segments from any given location", () => {
    const q = parseQuery("in:agents/integrator");
    expect(acceptsPath(q, ["memory/a.md", "agents/integrator/memory/a.md"], "note")).toBe(true);
    expect(acceptsPath(q, ["agents/integrator2/a.md"], "note")).toBe(false);
    expect(acceptsPath(parseQuery("-in:_threads"), ["_threads/t/README.md"], "thread_readme")).toBe(false);
  });

  it("reads frontmatter tags as a list or one comma-separated string", () => {
    expect(frontmatterTags(["Friction", "#Desktop", 7])).toEqual(["friction", "desktop", "7"]);
    expect(frontmatterTags("auth, Login")).toEqual(["auth", "login"]);
    expect(frontmatterTags(undefined)).toEqual([]);
  });

  it("matches tags any-of inside a group and all-of across groups", () => {
    const fm = { tags: ["auth", "desktop"], author: "Scout" };
    expect(acceptsFrontmatter(parseQuery("tag:auth,web"), fm)).toBe(true);
    expect(acceptsFrontmatter(parseQuery("tag:auth tag:web"), fm)).toBe(false);
    expect(acceptsFrontmatter(parseQuery("tag:auth -tag:desktop"), fm)).toBe(false);
    expect(acceptsFrontmatter(parseQuery("author:scout"), fm)).toBe(true);
    expect(acceptsFrontmatter(parseQuery("author:ui"), fm)).toBe(false);
    expect(acceptsFrontmatter(parseQuery("tag:auth"), null)).toBe(false);
  });

  it("decides most documents from frontmatter text without parsing YAML", () => {
    const block = "---\ntags:\n  - Friction\nauthor: Integrator\n---";
    expect(frontmatterTextDecision(parseQuery("tag:friction"), block)).toBe("parse");
    expect(frontmatterTextDecision(parseQuery("tag:blocker"), block)).toBe("no");
    expect(frontmatterTextDecision(parseQuery("tag:friction"), null)).toBe("no");
    expect(frontmatterTextDecision(parseQuery("-tag:blocker"), block)).toBe("yes");
    expect(frontmatterTextDecision(parseQuery("-tag:friction"), block)).toBe("parse");
    expect(frontmatterTextDecision(parseQuery("author:scout"), block)).toBe("no");
  });
});
