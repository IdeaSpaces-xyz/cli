import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spacesCommand } from "../commands/spaces.js";
import { runMapEdit } from "../commands/map-edit.js";
const ID = "n_" + "a".repeat(24);
const global = { json: true, quiet: true, yes: false, help: false };
const DOC = "---\nname: Research\nsummary: A copy\nmap:\n  roots: []\n  members:\n    - address: thread:x_original\n      depth: summary\n---\n\nOur legend.\n";
let dir: string, stdout: string, stderr: string, payload: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-export-")); stdout = ""; stderr = ""; payload = DOC;
  vi.stubEnv("HOME", dir); vi.stubEnv("IDEASPACES_AUTH", ""); vi.stubEnv("IS_API_KEY", "fixture"); vi.stubEnv("IS_API_URL", "http://localhost:1234");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(payload, { status: 200 })));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
describe("Space export copy", () => {
  it("writes the portable document verbatim, without a binding", async () => {
    const path = join(dir, "research.map.md");
    expect(await spacesCommand.run(["export", ID, path], {}, global)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(DOC);
    expect(JSON.parse(stdout)).toMatchObject({ path, source: ID, copy: true });
    expect(existsSync(join(dir, ".ideaspaces"))).toBe(false);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`http://localhost:1234/api/v1/maps/${ID}/export`);
  });
  it("never overwrites a path, including a local Map", async () => {
    const path = join(dir, "research.map.md"); writeFileSync(path, "keep me");
    expect(await spacesCommand.run(["export", ID, path], {}, global)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("keep me");
  });
  it("refuses invalid documents and non-Map destinations without writing", async () => {
    const path = join(dir, "research.map.md"); payload = "not a Map";
    expect(await spacesCommand.run(["export", ID, path], {}, global)).toBe(1);
    expect(existsSync(path)).toBe(false);
    payload = DOC;
    expect(await spacesCommand.run(["export", ID, join(dir, "anything.txt")], {}, global)).toBe(1);
  });
  it("shares the exclusive-create writer with local Map creation", async () => {
    const path = join(dir, "local.map.md");
    expect(await runMapEdit(["create", path], { name: "Local", summary: "A view" }, global)).toBe(0);
    const before = readFileSync(path, "utf8");
    expect(await runMapEdit(["create", path], { name: "Other", summary: "Other" }, global)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
