import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/credentials.js")>()),
  loadConfig: loadConfigMock,
}));

const { orgsCommand } = await import("../commands/orgs.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const TEXT: GlobalFlags = { json: false, quiet: true, yes: false, help: false };
const JSON_G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

const MEMBERS = {
  hostname: "acme.com",
  members: [
    { user_id: 1, username: "ann", email: "ann@acme.com", org_role: "OWNER", status: "active", sources: ["org"] },
    { user_id: 2, username: "bo", email: null, org_role: "MEMBER", status: "active", sources: ["org"] },
    { user_id: 3, username: null, email: "new@acme.com", org_role: "MEMBER", status: "active", sources: ["org"] },
    { user_id: 4, username: "cy", email: "cy@acme.com", org_role: "MEMBER", status: "removed", sources: ["org"] },
  ],
};

let stdout: string;
let stderr: string;
let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue(CFG);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    stdout += typeof c === "string" ? c : Buffer.from(c).toString("utf-8");
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => {
    stderr += typeof c === "string" ? c : Buffer.from(c).toString("utf-8");
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("orgs members", () => {
  it("reads the organization's members from its own route", async () => {
    answer(200, MEMBERS);
    expect(await orgsCommand.run(["members", "acme.com"], {}, TEXT)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/orgs/acme.com/members");
    expect(init.method).toBe("GET");
  });

  it("names each member by @handle, with role, and says who has no handle yet", async () => {
    answer(200, MEMBERS);
    expect(await orgsCommand.run(["members", "acme.com"], {}, TEXT)).toBe(0);
    expect(stdout).toContain("acme.com: 3 members");
    expect(stdout).toMatch(/@ann\s+ann@acme\.com\s+OWNER/);
    expect(stdout).toMatch(/@bo\s+MEMBER/);
    expect(stdout.split("\n").filter((line) => /\s$/.test(line))).toEqual([]);
    expect(stdout).toMatch(/\(no handle yet\)\s+new@acme\.com\s+MEMBER/);
    // A removed member is still shown, marked, after the active ones.
    expect(stdout).toMatch(/@cy\s+cy@acme\.com\s+MEMBER · removed/);
    expect(stdout.indexOf("@cy")).toBeGreaterThan(stdout.indexOf("(no handle yet)"));
    // Internal user ids stay behind the command.
    expect(stdout).not.toMatch(/user_id|\b[1-4]\b  /);
    expect(stdout).toContain("ideaspaces share person @handle");
    expect(stdout).toContain("ideaspaces share team acme.com");
  });

  it("gives the service's answer unchanged as JSON", async () => {
    answer(200, MEMBERS);
    expect(await orgsCommand.run(["members", "acme.com"], {}, JSON_G)).toBe(0);
    expect(JSON.parse(stdout)).toEqual(MEMBERS);
  });

  it("takes the hostname: address and any case", async () => {
    answer(200, { hostname: "acme.com", members: [] });
    expect(await orgsCommand.run(["members", "hostname:ACME.com"], {}, TEXT)).toBe(0);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.example.test/api/v1/orgs/acme.com/members");
    expect(stdout).toContain("acme.com: 0 members");
    expect(stdout).not.toContain("Share with one of them");
  });

  it("says only an owner can list members, in the service's words, and how to share with the team anyway", async () => {
    answer(403, { detail: "Only organization owners can view organization members" });
    expect(await orgsCommand.run(["members", "acme.com"], {}, TEXT)).toBe(1);
    expect(stderr).toContain("Only organization owners can view organization members");
    expect(stderr).toContain("Only an owner of acme.com can list its members");
    expect(stderr).toContain("ideaspaces share team acme.com");
    expect(stderr).not.toContain("403");
  });

  it("refuses a malformed hostname, extra arguments and unknown flags before any call", async () => {
    expect(await orgsCommand.run(["members", "not a host"], {}, TEXT)).toBe(1);
    expect(stderr).toContain("Expected an organization's hostname, like acme.com");
    expect(await orgsCommand.run(["members", "acme.com", "extra"], {}, TEXT)).toBe(1);
    expect(await orgsCommand.run(["members"], {}, TEXT)).toBe(1);
    expect(await orgsCommand.run(["members", "acme.com"], { all: true }, TEXT)).toBe(1);
    expect(stderr).toContain("Unknown flag for orgs: --all");
    expect(await orgsCommand.run(["list"], {}, TEXT)).toBe(1);
    expect(stderr).toContain("Usage: ideaspaces orgs members <hostname>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the session expired on a 401, and keeps a refusal off stdout under --json", async () => {
    answer(401, { detail: "Not authenticated" });
    expect(await orgsCommand.run(["members", "acme.com"], {}, TEXT)).toBe(1);
    expect(stderr).toContain("Session expired. Run `ideaspaces login`.");
    answer(403, { detail: "Only organization owners can view organization members" });
    stdout = "";
    expect(await orgsCommand.run(["members", "acme.com"], {}, JSON_G)).toBe(1);
    expect(stdout).toBe("");
  });

  it("asks to sign in when there is no session", async () => {
    loadConfigMock.mockReturnValue(null);
    expect(await orgsCommand.run(["members", "acme.com"], {}, TEXT)).toBe(1);
    expect(stderr).toContain("Not logged in");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
