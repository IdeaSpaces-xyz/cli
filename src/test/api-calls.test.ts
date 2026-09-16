import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The inventory scripts are plain ESM so `node scripts/…` runs them without a build.
import { extractApiCalls, renderInventory, INVENTORY, SOURCE } from "../../scripts/api-calls.mjs";
import { checkApiParity, erasePathParams } from "../../scripts/check-api-parity.mjs";

const root = join(__dirname, "..", "..");

describe("API call inventory", () => {
  it("is regenerated whenever api.ts changes", () => {
    // Fails when a call is added, removed, or reshaped in src/auth/api.ts
    // without `node scripts/api-calls.mjs` — the inventory is what the parity
    // check reads, so it must never lag the source it describes.
    const calls = extractApiCalls(readFileSync(join(root, SOURCE), "utf8"));
    expect(calls.length).toBeGreaterThan(20);
    expect(readFileSync(join(root, INVENTORY), "utf8")).toBe(renderInventory(calls));
  });

  it("reduces every path-building shape api.ts uses to one placeholder form", () => {
    const calls = extractApiCalls(
      [
        'const API_V1 = "/api/v1";',
        "const repoBase = (repoId: string) => `${API_V1}/repos/${encodeURIComponent(repoId)}`;",
        "function filesPath(repoId: string, path: string): string {",
        '  const segs = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");',
        "  return `${API_V1}/repos/${encodeURIComponent(repoId)}/files/${segs}`;",
        "}",
        "async function a(config, id: string, owner?: string, path = \"\") {",
        '  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";',
        '  const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";',
        '  await request(config, "GET", `${API_V1}/agents${qs}`);',
        '  await request(config, "GET", `${API_V1}/content/${encodeURIComponent(id)}/tree${suffix}`);',
        '  await request(config, "PUT", filesPath(id, path), {});',
        '  await request(config, enabled ? "PUT" : "DELETE", `${repoBase(id)}/flag`);',
        '  const p = `${API_V1}/stream/${encodeURIComponent(id)}`;',
        '  await fetch(`${config.apiUrl}${p}`, { method: "POST", body: "" });',
        "}",
        "async function request(config, method, path) {",
        "  await fetch(`${config.apiUrl}${path}`, { method });",
        "}",
      ].join("\n"),
      "fixture.ts",
    );
    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/agents" },
      { method: "GET", path: "/api/v1/content/{id}/tree" },
      { method: "GET", path: "/api/v1/content/{id}/tree/{path}" },
      { method: "PUT", path: "/api/v1/repos/{id}/files/{path}" },
      { method: "DELETE", path: "/api/v1/repos/{id}/flag" },
      { method: "PUT", path: "/api/v1/repos/{id}/flag" },
      { method: "POST", path: "/api/v1/stream/{id}" },
    ]);
  });

  it("refuses a path shape it cannot normalize rather than dropping the call", () => {
    expect(() =>
      extractApiCalls('async function a(config) { await request(config, "GET", buildPath()); }', "fixture.ts"),
    ).toThrow(/fixture.ts:1: cannot name a placeholder for buildPath\(\)/);
    expect(() =>
      extractApiCalls('async function a(config, m) { await request(config, m, "/x"); }', "fixture.ts"),
    ).toThrow(/method is not a literal/);
  });
});

describe("API parity check", () => {
  const openapi = {
    paths: {
      "/api/v1/repos/{repo_id}/access": { get: {}, patch: {} },
      "/api/v1/repos/{repo_id}/space-access": { get: { deprecated: true }, patch: { deprecated: true } },
      "/api/v1/repos/{repo_id}/files/{path}": { get: {}, put: {}, parameters: [] },
    },
  };

  it("matches path parameters by position, not name", () => {
    expect(erasePathParams("/api/v1/repos/{repoId}/files/{path}")).toBe("/api/v1/repos/{}/files/{}");
    const r = checkApiParity([{ method: "PUT", path: "/api/v1/repos/{repoId}/files/{segs}" }], openapi);
    expect(r).toEqual({ absent: [], deprecated: [], served: 1 });
  });

  it("fails on absent and deprecated operations — the retired-route case", () => {
    const r = checkApiParity(
      [
        { method: "GET", path: "/api/v1/repos/{repoId}/space-access" },
        { method: "PATCH", path: "/api/v1/repos/{repoId}/space-access" },
        { method: "DELETE", path: "/api/v1/repos/{repoId}/files/{path}" },
        { method: "GET", path: "/api/v1/repos/{repoId}/access" },
      ],
      openapi,
    );
    expect(r.served).toBe(3);
    expect(r.absent).toEqual([{ method: "DELETE", path: "/api/v1/repos/{repoId}/files/{path}" }]);
    expect(r.deprecated.map((d) => `${d.method} ${d.served_as}`)).toEqual([
      "GET /api/v1/repos/{repo_id}/space-access",
      "PATCH /api/v1/repos/{repo_id}/space-access",
    ]);
  });

  // The server's route table is private; the document is an input, never a
  // checked-in copy. Point IDEASPACES_OPENAPI at an export to run the real check.
  it.skipIf(!process.env.IDEASPACES_OPENAPI)("holds the checked-in inventory against a real OpenAPI document", () => {
    const doc = JSON.parse(readFileSync(process.env.IDEASPACES_OPENAPI as string, "utf8"));
    const { calls } = JSON.parse(readFileSync(join(root, INVENTORY), "utf8"));
    const r = checkApiParity(calls, doc);
    expect(r.absent, "operations the server does not serve").toEqual([]);
    expect(r.deprecated, "operations the server marks deprecated").toEqual([]);
  });
});
