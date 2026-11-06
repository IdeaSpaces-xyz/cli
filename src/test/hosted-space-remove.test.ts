import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spacesCommand } from "../commands/spaces.js";
const ID = "n_" + "a".repeat(24), HEAD = "n_" + "b".repeat(24);
const global = { json: true, quiet: true, yes: false, help: false };
let stdout: string, stderr: string, status: number;
beforeEach(() => {
  stdout = ""; stderr = ""; status = 200;
  vi.stubEnv("IDEASPACES_AUTH", ""); vi.stubEnv("IS_API_KEY", "fixture"); vi.stubEnv("IS_API_URL", "http://localhost:1234");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status === 200 ? { map_id: ID, version_id: HEAD, ordinal: 3 } : { detail: status === 400 ? "Cannot remove Core" : "Map head changed or forbidden" }), { status })));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const flags = { "if-match": HEAD, "command-id": "remove-1" };
describe("hosted Space pointer removal", () => {
  it("previews locally without making any request", async () => {
    expect(await spacesCommand.run(["remove", ID, "1"], flags, global)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ preview: true, member_ordinal: 1, expected_head_version_id: HEAD, command_id: "remove-1", access_checked: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("confirms one DELETE with the exact head, ordinal and command", async () => {
    expect(await spacesCommand.run(["remove", ID, "1"], flags, { ...global, yes: true })).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`http://localhost:1234/api/v1/maps/${ID}/members/1`); expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({ command_id: "remove-1", expected_head_version_id: HEAD });
  });
  it("refuses malformed ordinals or a missing head before I/O", async () => {
    for (const ordinal of ["-1", "1.2", "01", "9007199254740992", "Core"]) expect(await spacesCommand.run(["remove", ID, ordinal], flags, global)).toBe(1);
    expect(await spacesCommand.run(["remove", ID, "1"], {}, global)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never reloads or retries Core, stale-head or owner refusals", async () => {
    for (status of [400, 403, 409]) {
      vi.mocked(fetch).mockClear();
      expect(await spacesCommand.run(["remove", ID, "0"], flags, { ...global, yes: true })).toBe(1);
      expect(fetch).toHaveBeenCalledOnce(); expect(stderr).toContain("Command: remove-1");
    }
  });
});

it("distinguishes settled 4xx from ambiguous 5xx, network and unreadable writes", async () => {
  status = 403;
  expect(await spacesCommand.run(["remove", ID, "1"], flags, { ...global, yes: true })).toBe(1);
  expect(stderr).not.toContain("outcome may be uncertain");
  status = 503; stderr = "";
  expect(await spacesCommand.run(["remove", ID, "1"], flags, { ...global, yes: true })).toBe(1);
  expect(stderr).toContain("outcome may be uncertain");
  for (const failure of [() => { throw new TypeError("fetch failed"); }, () => new Response("not JSON", { status: 200 })]) {
    stderr = ""; vi.stubGlobal("fetch", vi.fn(async () => failure()));
    expect(await spacesCommand.run(["remove", ID, "1"], flags, { ...global, yes: true })).toBe(1);
    expect(fetch).toHaveBeenCalledOnce(); expect(stderr).toContain("outcome may be uncertain");
  }
});
it("maps 401 and rejects unknown flags and long command ids before writes", async () => {
  expect(await spacesCommand.run(["remove", ID, "1"], { ...flags, bad: true }, global)).toBe(1);
  expect(await spacesCommand.run(["remove", ID, "1"], { ...flags, "command-id": "x".repeat(65) }, global)).toBe(1);
  expect(fetch).not.toHaveBeenCalled(); status = 401;
  expect(await spacesCommand.run(["remove", ID, "1"], flags, { ...global, yes: true })).toBe(1);
  expect(stderr).toContain("Session expired");
});

it("accepts its documented example through the real argument parser", async () => {
  const { parseArgs } = await import("../argv.js");
  const parsed = parseArgs(spacesCommand.examples!.find(e => e.startsWith("ideaspaces spaces remove "))!.split(" ").slice(1));
  expect(await spacesCommand.run(parsed.args, parsed.flags, parsed.global)).toBe(0);
});

it("preserves shared API error details for JSON, plain, empty and existing untyped callers", async () => {
  const { apiErrorDetail, ApiStatusError } = await import("../auth/api.js");
  for (const [body, expected] of [[JSON.stringify({ detail: "Denied" }), "Denied"], ["plain refusal", "plain refusal"], ["", "HTTP 403"], ["   ", "HTTP 403"]]) {
    expect(apiErrorDetail(new ApiStatusError(403, body, null))).toBe(expected);
  }
  expect(apiErrorDetail(new Error('GET /example → 403: {"detail":"Existing refusal"}'))).toBe("Existing refusal");
});
