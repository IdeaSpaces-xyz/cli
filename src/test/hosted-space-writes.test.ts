import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spacesCommand } from "../commands/spaces.js";
const ID = "n_" + "a".repeat(24), HEAD = "n_" + "b".repeat(24);
const global = { json: true, quiet: true, yes: false, help: false };
let calls: Array<{ url: string; init: RequestInit }>, stdout: string, stderr: string;
let status: number;
beforeEach(() => {
  vi.stubEnv("IDEASPACES_AUTH", ""); vi.stubEnv("IS_API_KEY", "fixture-person"); vi.stubEnv("IS_API_URL", "http://localhost:1234");
  calls = []; stdout = ""; stderr = ""; status = 200;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(status === 200 ? { map_id: ID, version_id: HEAD, ordinal: 2, owner: "person:user_1", core_thread_id: "x_core" } : { detail: status === 409 ? "Map head changed" : "Forbidden" }), { status });
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const run = (args: string[], flags = {}) => spacesCommand.run(args, { "if-match": HEAD, "command-id": "edit-1", ...flags }, global);
describe("hosted Space add", () => {
  it("appends one authored address against the exact reviewed head", async () => {
    expect(await run(["add", ID, "thread:x_other"], { name: "Discussion" })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://localhost:1234/api/v1/maps/${ID}/members`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ command_id: "edit-1", expected_head_version_id: HEAD, member: { address: "thread:x_other", depth: "summary", name: "Discussion" } });
    expect(JSON.parse(stdout).command_id).toBe("edit-1");
  });
  it("sends a portable root object for a position, never a local checkout path", async () => {
    expect(await run(["add", ID], { position: "docs/a.md", "root-node-id": ID, sha: "c".repeat(40), depth: "surface" })).toBe(0);
    expect(JSON.parse(calls[0].init.body as string).member).toEqual({ root: { root_node_id: ID, sha: "c".repeat(40) }, position: "docs/a.md", depth: "surface" });
  });
  it("refuses missing heads, invalid members, unknown flags and mixed targets before I/O", async () => {
    expect(await spacesCommand.run(["add", ID, "https://example.com"], {}, global)).toBe(1);
    for (const flags of [{ position: "../escape", "root-node-id": ID }, { position: "/absolute", "root-node-id": ID }, { position: "x", "root-node-id": ID, sha: "bad" }, { depth: "invalid" }, { checkout: "/local" }]) {
      expect(await run(["add", ID], flags)).toBe(1);
    }
    expect(await run(["add", ID, "https://example.com"], { position: "x", "root-node-id": ID })).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it("does not reload or replay a stale or forbidden edit", async () => {
    for (status of [409, 403]) {
      calls = [];
      expect(await run(["add", ID, "https://example.com"])).toBe(1);
      expect(calls).toHaveLength(1);
      expect(stderr).toContain("Command: edit-1");
    }
  });
});

it("rejects invalid depth on a real address, long command ids and mixed roots without a retry hint", async () => {
  expect(await run(["add", ID, "https://example.com"], { depth: "invalid" })).toBe(1);
  expect(stderr).toContain("Invalid Map reference");
  expect(await run(["add", ID, "https://example.com"], { "command-id": "x".repeat(65) })).toBe(1);
  expect(await run(["add", ID, "https://example.com"], { "root-node-id": ID })).toBe(1);
  expect(calls).toHaveLength(0); expect(stderr).not.toContain("outcome");
});
it("maps 401 and shows ambiguity guidance only after a network attempt", async () => {
  status = 401;
  expect(await run(["add", ID, "https://example.com"])).toBe(1);
  expect(stderr).toContain("Session expired"); expect(stderr).not.toContain("outcome");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  expect(await run(["add", ID, "https://example.com"])).toBe(1);
  expect(stderr).toContain("outcome may be uncertain");
});
