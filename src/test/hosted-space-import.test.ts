import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spacesCommand } from "../commands/spaces.js";
const global = { json: true, quiet: true, yes: false, help: false };
const DOC = "---\nname: Research\nsummary: A copy\nmap:\n  roots: []\n  members:\n    - address: thread:x_original\n      depth: summary\n---\n\nOur legend.\n";
let dir: string, path: string, stdout: string, stderr: string, calls: Array<{ url: string; init: RequestInit }>;
let refusal: boolean, failWrite: boolean;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-import-")); path = join(dir, "research.map.md"); writeFileSync(path, DOC);
  stdout = ""; stderr = ""; calls = []; refusal = false; failWrite = false;
  vi.stubEnv("HOME", dir); vi.stubEnv("IDEASPACES_AUTH", ""); vi.stubEnv("IS_API_KEY", "fixture"); vi.stubEnv("IS_API_URL", "http://localhost:1234");
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/vaults")) return new Response(JSON.stringify(refusal ? { detail: "Person sign-in required" } : { personal: {}, orgs: [], shared_with_me: [] }), { status: refusal ? 403 : 200 });
    if (failWrite) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ map_id: "n_new_copy", version_id: "n_version", members: [] }), { status: 201 });
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
