import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spacesCommand } from "../commands/spaces.js";
const global = { json: true, quiet: true, yes: false, help: false };
const DOC = "---\nname: Research\nsummary: A copy\nmap:\n  roots: []\n  members:\n    - address: thread:x_original\n      depth: summary\n---\n\nOur legend.\n";
let dir: string, path: string, stdout: string, stderr: string, calls: Array<{ url: string; init: RequestInit }>;
let refusal: boolean, failWrite: boolean, writeStatus: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-import-")); path = join(dir, "research.map.md"); writeFileSync(path, DOC);
  stdout = ""; stderr = ""; calls = []; refusal = false; failWrite = false; writeStatus = 201;
  vi.stubEnv("HOME", dir); vi.stubEnv("IDEASPACES_AUTH", ""); vi.stubEnv("IS_API_KEY", "fixture"); vi.stubEnv("IS_API_URL", "http://localhost:1234");
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/vaults")) return new Response(JSON.stringify(refusal ? { detail: "Person sign-in required" } : { personal: {}, orgs: [], shared_with_me: [] }), { status: refusal ? 403 : 200 });
    if (failWrite) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(writeStatus === 201 ? { map_id: "n_new_copy", version_id: "n_version", members: [] } : { detail: "Import refused" }), { status: writeStatus });
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
describe("Space import copy", () => {
  it("uses the person-only gate, posts the document verbatim and leaves local state alone", async () => {
    expect(await spacesCommand.run(["import", path], {}, global)).toBe(0);
    expect(calls.map(c => c.url)).toEqual(["http://localhost:1234/api/v1/vaults", "http://localhost:1234/api/v1/maps/import"]);
    expect(calls[1].init.method).toBe("POST"); expect(calls[1].init.body).toBe(DOC);
    expect(new Headers(calls[1].init.headers).get("Content-Type")).toContain("text/plain");
    expect(JSON.parse(stdout).map_id).toBe("n_new_copy");
    expect(readFileSync(path, "utf8")).toBe(DOC); expect(existsSync(join(dir, ".ideaspaces"))).toBe(false);
  });
  it("refuses invalid local shape and unsupported Vault selection before I/O", async () => {
    expect(await spacesCommand.run(["import", path], { vault: "node:company" }, global)).toBe(1);
    writeFileSync(path, "not a Map");
    expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it("does not write when the person-only authority refuses", async () => {
    refusal = true;
    expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
    expect(calls).toHaveLength(1); expect(stderr).toContain("Person sign-in required");
  });
  it("does not replay an ambiguous import", async () => {
    failWrite = true;
    expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
    expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
    expect(stderr).toContain("another import creates another copy");
  });
});

it("reports settled import refusal without suggesting a duplicate copy may exist", async () => {
  writeStatus = 422;
  expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
  expect(stderr).toContain("Import refused"); expect(stderr).not.toContain("another copy");
});
it("rejects missing and oversized documents before network access", async () => {
  expect(await spacesCommand.run(["import", join(dir, "missing.map.md")], {}, global)).toBe(1);
  writeFileSync(path, DOC + "x".repeat(1024 * 1024));
  expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
  expect(stderr).toContain("1 MiB"); expect(calls).toHaveLength(0);
});
it("extracts a typed API refusal's human detail", async () => {
  const { apiErrorDetail, ApiStatusError } = await import("../auth/api.js");
  expect(apiErrorDetail(new ApiStatusError(403, JSON.stringify({ detail: { code: "person_required", message: "Person required" } }), null))).toBe("Person required");
});

it("keeps empty typed refusals readable and tests real --json argv", async () => {
  const { apiErrorDetail, ApiStatusError } = await import("../auth/api.js");
  expect(apiErrorDetail(new ApiStatusError(503, "", null))).toBe("HTTP 503");
  const { parseArgs } = await import("../argv.js");
  const parsed = parseArgs(["spaces", "import", path, "--json"]);
  expect(await spacesCommand.run(parsed.args, parsed.flags, parsed.global)).toBe(0);
  expect(JSON.parse(stdout).map_id).toBe("n_new_copy");
});
it("maps post-send 401 and 5xx without replay", async () => {
  writeStatus = 401;
  expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
  expect(stderr).toContain("Session expired"); expect(stderr).not.toContain("another copy");
  stdout = ""; stderr = ""; calls = []; writeStatus = 503;
  expect(await spacesCommand.run(["import", path], {}, global)).toBe(1);
  expect(stderr).toContain("another import creates another copy");
  expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
});

it("preserves shared API error details for JSON, plain, empty and existing untyped callers", async () => {
  const { apiErrorDetail, ApiStatusError } = await import("../auth/api.js");
  for (const [body, expected] of [[JSON.stringify({ detail: "Denied" }), "Denied"], ["plain refusal", "plain refusal"], ["", "HTTP 403"], ["   ", "HTTP 403"]]) {
    expect(apiErrorDetail(new ApiStatusError(403, body, null))).toBe(expected);
  }
  expect(apiErrorDetail(new Error('GET /example → 403: {"detail":"Existing refusal"}'))).toBe("Existing refusal");
});
