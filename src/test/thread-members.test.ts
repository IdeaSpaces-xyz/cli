import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { threadsCommand } from "../commands/threads.js";
import { catalogFlagError } from "../agent-tools/flags.js";

// Shapes as the service answers GET /threads/{id}, POST /threads/{id}/members and
// DELETE /threads/{id}/members/{ref}; values synthetic.
const T = "x_0123456789abcdef0123456789abcdef";
const SERVICE = "https://api.ideaspaces.test";
const AGENT = "n_0123456789abcdef01234567";
const JSON_FLAGS = { json: true, quiet: true, yes: false, help: false };
const TEXT_FLAGS = { json: false, quiet: true, yes: false, help: false };

const VIEW = {
  participants: [
    { actor_ref: "person:user_1", handle: "ada", display_name: "Ada", picture_url: null, grade: "Editor" },
    { actor_ref: "person:user_2", handle: "bo", display_name: "Bo", picture_url: null, grade: "Commenter" },
  ],
  agents: [{
    principal_ref: "person:user_1", principal_label: "Ada", principal_handle: "ada", principal_picture_url: null,
    agents: [
      { actor_ref: `agent:${AGENT}`, actor_label: "Keeper", agent_id: AGENT, member: true, access: "comment", grade: "Commenter" },
      { actor_ref: "agent:legacy", actor_label: "Old key", agent_id: null, member: false, access: null, grade: null },
    ],
  }],
  pending_invites: [{ invite_id: "inv_abc", email: "old@example.com", access: "view" }],
};
const DETAIL = { thread_id: T, name: "Letter", owner: "person:user_1", grade: "Editor", door_open: true, closed: false, last_seq: 3, ...VIEW };

interface Call { method: string; path: string; body?: unknown }
let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;
let home: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-thread-members-"));
  mkdirSync(join(home, ".ideaspaces"), { mode: 0o700 });
  writeFileSync(join(home, ".ideaspaces", "credentials.json"), JSON.stringify({ api_url: SERVICE, api_key: "k", username: "ada" }) + "\n", { mode: 0o600 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("IDEASPACES_AUTH", "");
  vi.stubEnv("IS_API_KEY", "");
  vi.stubEnv("IS_API_URL", "");
  vi.stubEnv("IS_WEB_URL", "");
  calls = [];
  answers = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    const hit = answers[`${method} ${url.pathname}`] ?? { status: 500, body: { detail: "no route" } };
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "Content-Type": "application/json" } });
  }));
  stdout = ""; stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const threads = (args: string[], flags: Record<string, string | boolean> = {}, global = TEXT_FLAGS) => {
  stdout = ""; stderr = "";
  return threadsCommand.run(args, flags, global);
};

describe("threads members", () => {
  it("lists people with their grade, member agents, pending invitations and the link to knock from", async () => {
    answers[`GET /api/v1/threads/${T}`] = { status: 200, body: DETAIL };
    expect(await threads(["members", T])).toBe(0);
    expect(stdout).toContain(`${T}  Letter`);
    expect(stdout).toMatch(/People \(2\):\n\s+@ada\s+Editor\n\s+@bo\s+Commenter/);
    expect(stdout).toMatch(/Agents \(1\):\n\s+Keeper\s+Commenter\s+agent:n_0123456789abcdef01234567\s+\(added by @ada\)/);
    expect(stdout).not.toContain("Old key"); // seen posting, not a member
    expect(stdout).toMatch(/Pending invitations \(1\):\n\s+old@example\.com\s+view\s+inv_abc/);
    expect(stdout).toContain(`Link: https://ideaspaces.test/t/${T}  (someone not in it can knock from it)`);
    expect(stdout).toContain(`ideaspaces threads add ${T} @handle`);
  });

  it("says when the door is closed, and gives the service's rows as JSON", async () => {
    answers[`GET /api/v1/threads/${T}`] = { status: 200, body: { ...DETAIL, door_open: false } };
    expect(await threads(["members", T], {}, JSON_FLAGS)).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toMatchObject({ schema: "ideaspaces.hosted-thread.members.v1", thread_id: T, name: "Letter", door_open: false });
    expect(data.participants).toEqual(VIEW.participants);
    expect(data.agents).toEqual(VIEW.agents);
    expect(data.pending_invites).toEqual(VIEW.pending_invites);
    expect(await threads(["members", T])).toBe(0);
    expect(stdout).toContain("its door is closed: nobody can knock until you open it on the web");
  });

  it("needs a hosted x_ id and takes no flags", async () => {
    expect(await threads(["members", "my-local-thread"])).toBe(1);
    expect(stderr).toContain("Usage: ideaspaces threads members x_<id>");
    expect(await threads(["members", T], { limit: "5" })).toBe(1);
    expect(stderr).toContain("--limit is not supported by hosted threads members; it takes no flags.");
    expect(calls).toEqual([]);
  });
});

describe("threads add", () => {
  it("adds people by handle at the level asked, and says who is in it now", async () => {
    answers[`POST /api/v1/threads/${T}/members`] = { status: 200, body: {
      thread_id: T, access: "view",
      added: [{ actor_ref: "person:user_3", handle: "cy", display_name: "Cy", picture_url: null, access: "view", previous: null },
        { actor_ref: "person:user_2", handle: "bo", display_name: "Bo", picture_url: null, access: "view", previous: "comment" }],
      invited: [], unchanged: [{ actor_ref: "person:user_4", handle: "di", display_name: "Di", picture_url: null, access: "view" }],
      post: null, ...VIEW,
    } };
    expect(await threads(["add", T, "@cy,@bo,@di"], { access: "view" })).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: `/api/v1/threads/${T}/members`, body: { people: ["cy", "bo", "di"], agents: [], access: "view" } }]);
    expect(stdout).toContain(`Added @cy at view to ${T}.`);
    expect(stdout).toContain("@bo: comment → view");
    expect(stdout).toContain("Already in at view, nothing changed: @di");
    expect(stdout).toContain("People (2):");
  });

  it("adds the person's own agents, at comment by default", async () => {
    answers[`POST /api/v1/threads/${T}/members`] = { status: 200, body: {
      thread_id: T, access: "comment", added: [{ actor_ref: `agent:${AGENT}`, actor_label: "Keeper", access: "comment", previous: null }],
      invited: [], unchanged: [], post: null, ...VIEW,
    } };
    expect(await threads(["add", T, ""], { agents: `agent:${AGENT}` }, JSON_FLAGS)).toBe(0);
    expect(calls[0].body).toEqual({ people: [], agents: [AGENT], access: "comment" });
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ideaspaces.hosted-thread.members-add.v1", thread_id: T, access: "comment" });
  });

  it("refuses an email before sending, since IdeaSpaces sends no invitation emails", async () => {
    expect(await threads(["add", T, "@cy,new@example.com"])).toBe(1);
    expect(stderr).toContain("IdeaSpaces sends no invitation emails, so a Thread takes people by @handle. Nothing was sent.");
    expect(stderr).toContain(`ideaspaces threads members ${T} prints it`);
    expect(calls).toEqual([]);
  });

  it("refuses a bad level, a bad handle, a repeat, too many people and a bad agent id before sending", async () => {
    expect(await threads(["add", T, "@cy"], { access: "edit" })).toBe(1);
    expect(stderr).toContain("--access must be comment (read and post) or view (read only).");
    expect(await threads(["add", T, "cy"])).toBe(1);
    expect(stderr).toContain("Name up to 16 distinct @handles");
    expect(await threads(["add", T, "@cy,@CY"])).toBe(1);
    expect(await threads(["add", T, Array.from({ length: 17 }, (_, i) => `@p${i}`).join(",")])).toBe(1);
    expect(await threads(["add", T, "@cy"], { agents: "n_nothex" })).toBe(1);
    expect(stderr).toContain("--agents takes up to 8 distinct Agent Actor ids");
    expect(await threads(["add", T, ""])).toBe(1);
    expect(stderr).toContain("Name at least one @handle, or --agents.");
    expect(await threads(["add", T, "@cy"], { grade: "view" })).toBe(1);
    expect(stderr).toContain("--grade is not supported by hosted threads add; it takes --access, --agents.");
    expect(calls).toEqual([]);
  });

  it("says what a refusal means: someone new knocks, a closed Thread, only the owner adds", async () => {
    answers[`POST /api/v1/threads/${T}/members`] = { status: 409, body: { detail: "Knock first" } };
    expect(await threads(["add", T, "@stranger"])).toBe(1);
    expect(stderr).toContain("someone new can't join a Thread with others. Nothing was sent.");
    answers[`POST /api/v1/threads/${T}/members`] = { status: 409, body: { detail: "Thread is closed" } };
    expect(await threads(["add", T, "@cy"])).toBe(1);
    expect(stderr).toContain("Service: Thread is closed");
    answers[`POST /api/v1/threads/${T}/members`] = { status: 403, body: { detail: "Only the Thread's owner manages its people" } };
    expect(await threads(["add", T, "@cy"])).toBe(1);
    expect(stderr).toContain("Error (forbidden)");
    expect(stderr).toContain("Service: Only the Thread's owner manages its people");
  });

  it("is a live verb in the catalog again, with its own flags", () => {
    expect(catalogFlagError("threads", ["add", T, "@cy"], { access: "view", agents: AGENT })).toBeUndefined();
    expect(catalogFlagError("threads", ["add", T, "@cy"], { grade: "view" })).toContain("Unknown flag for threads add: --grade");
    expect(catalogFlagError("threads", ["remove", T, "@cy"], { yes: true })).toContain("Unknown flag for threads remove: --yes");
  });
});

describe("threads remove", () => {
  it("removes a person by handle, an agent, or an invitation, and says who is left", async () => {
    answers[`DELETE /api/v1/threads/${T}/members/bo`] = { status: 200, body: {
      thread_id: T, removed: { actor_ref: "person:user_2", handle: "bo", display_name: "Bo", picture_url: null, previous: "comment" }, post: null, ...VIEW,
    } };
    expect(await threads(["remove", T, "@bo"])).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: `/api/v1/threads/${T}/members/bo` });
    expect(stdout).toContain(`Removed @bo from ${T}. What they already read can't be taken back.`);
    expect(stdout).toContain("People (2):");

    answers[`DELETE /api/v1/threads/${T}/members/agent%3A${AGENT}`] = { status: 200, body: {
      thread_id: T, removed: { actor_ref: `agent:${AGENT}`, actor_label: "Keeper" }, post: null, participants: null, agents: null, pending_invites: null,
    } };
    expect(await threads(["remove", T, `agent:${AGENT}`])).toBe(0);
    expect(stdout).toContain(`Removed Keeper from ${T}.`);
    expect(stdout).toContain("People: unknown (who is left could not be read)");

    answers[`DELETE /api/v1/threads/${T}/members/inv_abc`] = { status: 200, body: {
      thread_id: T, removed: { invite_id: "inv_abc", email: "old@example.com", access: "view" }, post: null, ...VIEW,
    } };
    expect(await threads(["remove", T, "inv_abc"], {}, JSON_FLAGS)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ideaspaces.hosted-thread.members-remove.v1", removed: { invite_id: "inv_abc" } });
  });

  it("names a member the way threads members lists them, or refuses before sending", async () => {
    for (const bad of ["bo", "person:user_2", "agent:someone", "old@example.com"]) {
      expect(await threads(["remove", T, bad])).toBe(1);
      expect(stderr).toContain("Name one member as threads members lists them");
    }
    expect(await threads(["remove", T])).toBe(1);
    expect(stderr).toContain("Usage: ideaspaces threads remove x_<id>");
    expect(calls).toEqual([]);
  });

  it("says when the member isn't there", async () => {
    answers[`DELETE /api/v1/threads/${T}/members/zed`] = { status: 404, body: { detail: "Member not found" } };
    expect(await threads(["remove", T, "@zed"])).toBe(1);
    expect(stderr).toContain("Error (not_found)");
  });
});
