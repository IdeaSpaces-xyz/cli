import { expect, it } from "vitest";
import { formatPortableMap } from "../portable-map.js";
it("formats authored Map coordinates and disclosure without changing authority", () => {
  const lines = formatPortableMap({ roots: [], members: [{ address: "https://example.org", depth: "summary", name: "Curated", disclosure: { name: "Observed", summary: "At read time" } }] }).join("\n");
  expect(lines).toContain("ceiling=summary");
  expect(lines).toContain('observed name="Observed"');
  expect(lines).toContain('curated name="Curated"');
});
