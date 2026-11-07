import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { spacesCommand } from "../commands/spaces.js";
import { parseArgs } from "../argv.js";

const ID = "n_" + "a".repeat(24), HEAD = "n_" + "b".repeat(24);
const global = { json: true, quiet: true, yes: false, help: false };
const flags = { hosted: true, vault: "person:user_123", name: "Research", summary: "Our work", message: "We work here.", "command-id": "create-1" };
let calls: Array<{ url: string; init: RequestInit }>, stdout: string, stderr: string, status: number;
let reply: unknown;
beforeEach(() => {
  vi.stubEnv("IDEASPACES_AUTH", "");
  vi.stubEnv("IS_API_KEY", "fixture-person");
  vi.stubEnv("IS_API_URL", "http://localhost:1234");
  calls = []; stdout = ""; stderr = ""; status = 201;
  reply = { map_id: ID, version_id: HEAD, ordinal: 1, owner: flags.vault, core_thread_id: "x_core" };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(status === 201 ? reply : { detail: "Refused" }, { status });
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const run = (change = {}) => spacesCommand.run(["new"], { ...flags, ...change }, global);

describe("hosted Space creation", () => {
  it("sends one explicit Vault-owned create with a valid Core Note, not a Repo or coordination Space", async () => {
    expect(await run()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:1234/api/v1/maps");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer fixture-person");
    const body = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(body).sort()).toEqual(["command_id", "core_note", "name", "owner", "summary"]);
    expect(body).toMatchObject({ command_id: "create-1", owner: flags.vault, name: flags.name, summary: flags.summary });
    expect(parse(body.core_note.split("---\n")[1])).toMatchObject({ id: expect.stringMatching(/^msg_[a-f0-9]{48}$/), kind: "post", name: "Research Core", summary: flags.summary });
    expect(body.core_note).toContain("We work here.");
    expect(JSON.parse(stdout)).toEqual({ ...reply as object, command_id: "create-1" });
  });
  it("derives the same opening bytes on exact retry without a date or new random post id", async () => {
    await run(); await run();
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect(JSON.parse(calls[0].init.body as string).core_note).not.toContain("date:");
    await run({ "command-id": "create-2" });
    expect(calls[2].init.body).not.toBe(calls[0].init.body);
  });
  it("resolves an explicit personal Vault through the signed-in account, not a cached handle", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(String(url).endsWith("/auth/me") ? { user_id: 123 } : reply);
    }));
    expect(await run({ vault: "personal" })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://localhost:1234/auth/me");
    expect(JSON.parse(calls[1].init.body as string).owner).toBe("person:user_123");
  });
  it("refuses an unreadable personal identity without attempting a write", async () => {
    expect(await run({ vault: "personal" })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(stderr).toContain("no Space was created");
    expect(stderr).not.toContain("outcome may be uncertain");
  });
  it("accepts an explicit company owner, leaving current ownership to the service", async () => {
    const vault = "node:n_" + "c".repeat(24);
    reply = { ...reply as object, owner: vault };
    expect(await run({ vault })).toBe(0);
    expect(JSON.parse(calls[0].init.body as string).owner).toBe(vault);
  });
  it.each([
    { hosted: undefined }, { hosted: "true" }, { hosted: "false" },
    { vault: undefined }, { vault: "person:n_" + "c".repeat(24) },
    { vault: "/local/vault" }, { vault: "@someone" }, { vault: "node:invalid" },
    { name: "" }, { name: "a".repeat(201) }, { summary: "a".repeat(1001) },
    { name: "two\nlines" }, { message: true }, { message: "" },
    { message: "a".repeat(32768) }, { "command-id": "a".repeat(65) },
    { "command-id": "two\nlines" }, { recipients: "@someone" }, { "post-id": "msg_other" },
  ])("refuses invalid or unsupported arguments before I/O: %j", async change => {
    expect(await run(change)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderr).not.toContain("outcome may be uncertain");
  });
  it("refuses positional arguments rather than ignoring them", async () => {
    expect(await spacesCommand.run(["new", "ignored"], flags, global)).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it.each([401, 402, 403, 409, 422, 429])("does not replay or call a settled %s uncertain", async code => {
    status = code;
    expect(await run()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(stderr).not.toContain("outcome may be uncertain");
    expect(stderr).toContain("Command: create-1");
    if (code === 402) expect(stderr).toContain("active Sync subscription");
    if (code === 403) expect(stderr).toContain("Vault you own");
  });
  it("keeps both identifiers visible in human success output", async () => {
    expect(await spacesCommand.run(["new"], flags, { ...global, json: false })).toBe(0);
    expect(stdout).toContain(ID); expect(stdout).toContain("x_core"); expect(stdout).toContain("Nothing else was shared");
  });
  it.each([null, {}, { map_id: ID }, { map_id: ID, version_id: HEAD, owner: flags.vault, ordinal: 1, core_thread_id: null }])("treats an unreadable successful receipt as uncertain: %j", async value => {
    reply = value;
    expect(await run()).toBe(1);
    expect(stderr).toContain("outcome may be uncertain");
    expect(calls).toHaveLength(1);
  });
  it("does not replay a 5xx", async () => {
    status = 503;
    expect(await run()).toBe(1);
    expect(stderr).toContain("same --command-id, --vault");
    expect(calls).toHaveLength(1);
  });
  it("does not replay a connection failure", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stderr).toContain("another command id creates another Space");
  });
  it("uses its documented flags through the real parser", async () => {
    const parsed = parseArgs(["spaces", "new", "--hosted", "--vault", flags.vault, "--name", flags.name, "--summary", flags.summary, "--message", flags.message, "--command-id", "create-1", "--json"]);
    expect(await spacesCommand.run(parsed.args, parsed.flags, parsed.global)).toBe(0);
  });
  it("reports a real transport deadline without replay", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const pending = run();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stderr).toContain("outcome may be uncertain");
  });
});
