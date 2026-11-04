import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAuthMe } from "../auth/api.js";
import { HostAuthRefusal, loadConfig } from "../auth/credentials.js";
import { forgetHostToken, HostTokenError, hostToken, readHostToken } from "../auth/host-token.js";
import { threadsCommand } from "../commands/threads.js";
import { vaultsCommand } from "../commands/vaults.js";
import { takeTokenFd } from "../host-token-flag.js";

// Recorded shapes: keys as the IdeaSpaces service answers /api/v1/threads and /api/v1/vaults; values synthetic.
const FIXTURES = join(__dirname, "fixtures", "hosted-threads");
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
const T = "x_0123456789abcdef0123456789abcdef";
const SERVICE = "https://api.ideaspaces.test";
const TERMINAL_KEY = "terminal-key-not-a-secret";
const HOST_KEY = "host-token-7f3a91c2e5";
const JSON_FLAGS = { json: true, quiet: true, yes: false, help: false };
const TEXT_FLAGS = { json: false, quiet: true, yes: false, help: false };

interface Call { method: string; url: URL; auth: string | null; type: string | null; body?: string }
type Route = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Error;
let calls: Call[];
let route: Route;
let home: string;
let credentials: string;
let stdout: string;
let stderr: string;

function respond(r: ReturnType<Route>): Response {
  if (r instanceof Error) throw r;
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", ...r.headers } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-hosted-threads-"));
  mkdirSync(join(home, ".ideaspaces"), { mode: 0o700 });
  credentials = join(home, ".ideaspaces", "credentials.json");
  writeFileSync(credentials, JSON.stringify({ api_url: SERVICE, api_key: TERMINAL_KEY, username: "ada" }) + "\n", { mode: 0o600 });
  utimesSync(credentials, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("IDEASPACES_AUTH", "");
  vi.stubEnv("IS_API_KEY", "");
  vi.stubEnv("IS_API_URL", "");
  calls = [];
  route = () => ({ status: 500, body: { detail: "no route" } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? "GET", url: new URL(String(input)), auth: headers.get("Authorization"), type: headers.get("Content-Type"),
      ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    calls.push(call);
    return respond(route(call));
  }));
  stdout = ""; stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdout += s; return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr += s; return true; }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  forgetHostToken();
  rmSync(home, { recursive: true, force: true });
});

const threads = async (args: string[], flags: Record<string, string | boolean> = {}, global = JSON_FLAGS) => {
  stdout = ""; stderr = "";
  return threadsCommand.run(args, flags, global);
};
const json = () => JSON.parse(stdout);
const path = (call: Call) => `${call.method} ${call.url.pathname}${call.url.search}`;

/** Route by method and path to a recorded fixture. */
function serve(table: Record<string, string | [number, string] | ((call: Call) => ReturnType<Route>)>): void {
  route = (call) => {
    const hit = table[`${call.method} ${call.url.pathname}`];
    if (!hit) return { status: 500, body: { detail: `unrouted ${call.method} ${call.url.pathname}` } };
    if (typeof hit === "function") return hit(call);
    const [status, name] = typeof hit === "string" ? [200, hit] : hit;
    return { status, body: fixture(name) };
  };
}

describe("vaults --json", () => {
  it("returns the service's personal, orgs and shared_with_me unchanged, on the terminal's own login", async () => {
    serve({ "GET /api/v1/vaults": "vaults" });
    expect(await vaultsCommand.run([], {}, JSON_FLAGS)).toBe(0);
    expect(json()).toEqual({ schema: "ideaspaces.vaults.v1", ...fixture("vaults") });
    expect(calls.map(path)).toEqual(["GET /api/v1/vaults"]);
    expect(calls[0].url.origin).toBe(SERVICE);
    expect(calls[0].auth).toBe(`Bearer ${TERMINAL_KEY}`);
  });

  it("names a refused agent credential (403 person_required) as forbidden", async () => {
    serve({ "GET /api/v1/vaults": [403, "vaults-403"] });
    expect(await vaultsCommand.run([], {}, JSON_FLAGS)).toBe(1);
    expect(json().error).toMatchObject({ state: "forbidden" });
  });

  it("says signed_out, and calls nothing, when the terminal has no login", async () => {
    rmSync(credentials);
    expect(await vaultsCommand.run([], {}, JSON_FLAGS)).toBe(1);
    expect(json().error).toMatchObject({ state: "signed_out" });
    expect(json().error.message).toContain("ideaspaces login");
    expect(calls).toEqual([]);
  });
});

describe("threads list --hosted", () => {
  it("lists one page and wraps the service cursor; the next page passes it back", async () => {
    serve({ "GET /api/v1/threads": (call) => ({ status: 200, body: fixture(call.url.searchParams.get("cursor") ? "threads-page-2" : "threads-page-1") }) });
    expect(await threads(["list"], { hosted: true })).toBe(0);
    const first = json();
    expect(first.schema).toBe("ideaspaces.hosted-threads.list.v1");
    expect(first.threads).toEqual([
      { id: T, name: "Launch plan", closed: false, unread_count: 2, read_seq: 4, last_seq: 6, last_post_at: "2026-10-29T10:06:00Z" },
      { id: "x_fedcba9876543210fedcba9876543210", name: "Retro", closed: true, unread_count: 0, read_seq: 4, last_seq: 6, last_post_at: "2026-10-29T10:06:00Z" },
    ]);
    expect(first.cursor).toEqual(expect.any(String));
    expect(first.cursor).not.toBe("c2VydmVyLWN1cnNvcg");
    expect(await threads(["list"], { hosted: true, cursor: first.cursor, limit: "10" })).toBe(0);
    expect(json()).toMatchObject({ threads: [{ id: "x_00000000000000000000000000000001" }], cursor: null });
    expect(calls.map(path)).toEqual(["GET /api/v1/threads?limit=50", "GET /api/v1/threads?limit=10&cursor=c2VydmVyLWN1cnNvcg"]);
  });

  it("refuses a cursor from another kind or service before calling, and a malformed answer as invalid_response", async () => {
    const foreign = Buffer.from(JSON.stringify({ source: "https://elsewhere.test", kind: "list", value: "c" })).toString("base64url");
    expect(await threads(["list"], { hosted: true, cursor: foreign })).toBe(1);
    expect(json().error.state).toBe("invalid_request");
    expect(calls).toEqual([]);
    serve({ "GET /api/v1/threads": () => ({ status: 200, body: { threads: [{ thread_id: "x_short", name: "Bad" }], next_cursor: null } }) });
    expect(await threads(["list"], { hosted: true })).toBe(1);
    expect(json().error.state).toBe("invalid_response");
  });

  it("keeps hosted flags apart from local ones", async () => {
    expect(await threads(["list"], { hosted: true, depth: "full" })).toBe(1);
    expect(json().error.message).toContain("--depth is not supported by hosted threads list");
    expect(calls).toEqual([]);
  });
});

describe("threads open x_<32hex>", () => {
  it("reads the head and the latest page; author and date are the service's, not the Note's", async () => {
    serve({ [`GET /api/v1/threads/${T}`]: "thread-head", [`GET /api/v1/threads/${T}/posts`]: "thread-posts-latest" });
    expect(await threads(["open", T], { limit: "2" })).toBe(0);
    const page = json();
    expect(page.schema).toBe("ideaspaces.hosted-thread.page.v1");
    expect(page.thread).toEqual({ id: T, name: "Launch plan", closed: false, grade: "Commenter", can_reply: true });
    expect(page.posts.map((p: any) => p.seq)).toEqual([5, 6]);
    const forged = page.posts[1];
    expect(forged.fields.author).toBe("Mallory"); // authored text, kept as written
    expect(forged.author).toBe("@ada");
    expect(forged.author_ref).toBe("person:user_7");
    expect(forged.date).toBe("2026-10-29T10:06:00Z");
    expect(page.older_cursor).toEqual(expect.any(String)); // a full page starting after seq 1
    expect(page.has_more).toBe(false);
    expect(calls.map(path)).toEqual([`GET /api/v1/threads/${T}`, `GET /api/v1/threads/${T}/posts?limit=2`]);

    expect(await threads(["open", T], { limit: "2" }, TEXT_FLAGS)).toBe(0);
    expect(stdout).toContain("@ada · 2026-10-29T10:0");
    expect(stdout).not.toContain("Mallory");
    expect(stdout).not.toContain("1999");
  });

  it("pages older with before_seq, and follows with after_seq, advancing past folded events once drained", async () => {
    let posts = "thread-posts-latest";
    serve({ [`GET /api/v1/threads/${T}`]: "thread-head", [`GET /api/v1/threads/${T}/posts`]: () => ({ status: 200, body: fixture(posts) }) });
    expect(await threads(["open", T], { limit: "2" })).toBe(0);
    const { older_cursor: older, cursor: follow } = json();
    posts = "thread-posts-older";
    expect(await threads(["open", T], { limit: "2", cursor: older })).toBe(0);
    expect(json().posts.map((p: any) => p.seq)).toEqual([1]);
    expect(json().older_cursor).toBeNull(); // not a full page: exhausted
    expect(path(calls.at(-1)!)).toBe(`GET /api/v1/threads/${T}/posts?limit=2&before_seq=5`);

    posts = "thread-posts-empty";
    expect(await threads(["open", T], { cursor: follow })).toBe(0);
    expect(path(calls.at(-1)!)).toBe(`GET /api/v1/threads/${T}/posts?limit=50&after_seq=6`);
    expect(json()).toMatchObject({ posts: [], refresh: false, has_more: false, cursor: follow });

    // Two later events that the page folds out (a correction, a mark) moved last_seq to 8.
    let head = { ...fixture("thread-head"), last_seq: 8 };
    serve({ [`GET /api/v1/threads/${T}`]: () => ({ status: 200, body: head }), [`GET /api/v1/threads/${T}/posts`]: "thread-posts-empty",
      [`POST /api/v1/threads/${T}/ack`]: (call) => ({ status: 200, body: { thread_id: T, read_seq: JSON.parse(call.body!).seq } }) });
    expect(await threads(["open", T], { cursor: follow })).toBe(0);
    const drained = json();
    expect(drained).toMatchObject({ posts: [], refresh: true, has_more: false });
    expect(await threads(["ack", T], { cursor: drained.cursor })).toBe(0);
    expect(json().read_seq).toBe(8);

    // A full follow page never skips: the cursor stops at its last seq, and there is more.
    head = { ...fixture("thread-head"), last_seq: 10 };
    const later = fixture("thread-posts-latest").posts.map((p: any, i: number) => ({ ...p, seq: 7 + i }));
    serve({ [`GET /api/v1/threads/${T}`]: () => ({ status: 200, body: head }), [`GET /api/v1/threads/${T}/posts`]: () => ({ status: 200, body: { posts: later } }) });
    expect(await threads(["open", T], { cursor: follow, limit: "2" })).toBe(0);
    const full = json();
    expect(full).toMatchObject({ refresh: true, has_more: true });
    expect(JSON.parse(Buffer.from(full.cursor, "base64url").toString()).value).toBe(8);
    // A page that is not after the cursor is a broken answer, never a partial page.
    serve({ [`GET /api/v1/threads/${T}`]: () => ({ status: 200, body: head }), [`GET /api/v1/threads/${T}/posts`]: "thread-posts-latest" });
    expect(await threads(["open", T], { cursor: follow, limit: "2" })).toBe(1);
    expect(json().error.state).toBe("invalid_response");
  });

  it("answers 404 for no access exactly as for absence, as not_found, and refuses another Thread's cursor", async () => {
    serve({ [`GET /api/v1/threads/${T}`]: [404, "thread-404"] });
    expect(await threads(["open", T])).toBe(1);
    expect(json().error).toEqual({ state: "not_found", message: expect.stringContaining("no access") });
    expect(stderr).toContain("Error (not_found)");
    serve({ [`GET /api/v1/threads/${T}`]: "thread-head", [`GET /api/v1/threads/${T}/posts`]: "thread-posts-latest" });
    expect(await threads(["open", T], { limit: "2" })).toBe(0);
    const other = "x_fedcba9876543210fedcba9876543210";
    const before = calls.length;
    expect(await threads(["open", other], { cursor: json().cursor })).toBe(1);
    expect(json().error.state).toBe("invalid_request");
    expect(calls.length).toBe(before); // refused before any request
  });

  it("names each status as the desktop client does", async () => {
    for (const [status, state] of [[401, "expired"], [403, "forbidden"], [409, "conflict"], [429, "rate_limited"], [400, "invalid_request"], [503, "unavailable"]] as const) {
      serve({ [`GET /api/v1/threads/${T}`]: () => ({ status, body: { detail: "x" }, headers: status === 429 ? { "Retry-After": "3" } : {} }) });
      expect(await threads(["open", T])).toBe(1);
      expect(json().error.state, String(status)).toBe(state);
      if (status === 429) expect(json().error.retry_after_ms).toBe(3000);
    }
    route = () => new TypeError("fetch failed");
    expect(await threads(["open", T])).toBe(1);
    expect(json().error.state).toBe("offline");
  });
});

describe("threads post x_<32hex>", () => {
  it("sends one text/plain Note with no authored date or author, and reads back the service's post", async () => {
    serve({ [`POST /api/v1/threads/${T}/posts`]: "post-created" });
    expect(await threads(["post", T], { "reply-to": "msg_reply_two", message: "Answer.", "post-id": "msg_cli_fixed" })).toBe(0);
    expect(json()).toMatchObject({ schema: "ideaspaces.hosted-thread.post.v1", thread_id: T, post: { id: "msg_cli_fixed", seq: 7, author: "@ada", surface: "human" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("text/plain; charset=utf-8");
    expect(calls[0].body).toBe("---\nid: msg_cli_fixed\nkind: post\nin_reply_to: msg_reply_two\n---\n\nAnswer.\n");
    // The same --post-id and arguments resend the same bytes: what the service accepts after an ambiguous failure.
    expect(await threads(["post", T], { "reply-to": "msg_reply_two", message: "Answer.", "post-id": "msg_cli_fixed" })).toBe(0);
    expect(calls[1].body).toBe(calls[0].body);
  });

  it("never retries a failed POST and names the id to resend", async () => {
    route = () => new TypeError("fetch failed");
    expect(await threads(["post", T], { "reply-to": "msg_reply_two", message: "Answer." })).toBe(1);
    expect(calls).toHaveLength(1);
    const error = json().error;
    expect(error.state).toBe("offline");
    expect(error.post_id).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(error.message).toContain(`--post-id ${error.post_id}`);
  });

  it("answers no access with not_found, and refuses a bad reply before calling", async () => {
    serve({ [`POST /api/v1/threads/${T}/posts`]: [404, "thread-404"] });
    expect(await threads(["post", T], { "reply-to": "msg_reply_two", message: "Answer." })).toBe(1);
    expect(json().error.state).toBe("not_found");
    expect(json().error.message).not.toContain("--post-id"); // a 404 is not ambiguous
    calls = [];
    for (const flags of [{ message: "No parent." }, { "reply-to": "latest", message: "x" }, { "reply-to": "msg_a", message: "" }, { "reply-to": "msg_a", message: "x", author: "Me" }]) {
      expect(await threads(["post", T], flags as Record<string, string>)).toBe(1);
      expect(json().error.state).toBe("invalid_request");
    }
    expect(calls).toEqual([]);
  });

  it("refuses a multi-line name and a Note larger than the service takes, before calling", async () => {
    serve({ [`POST /api/v1/threads/${T}/posts`]: "post-created" });
    expect(await threads(["post", T], { "reply-to": "msg_a", message: "x", name: "Two\nlines" })).toBe(1);
    expect(json().error).toMatchObject({ state: "invalid_request", message: expect.stringContaining("--name must be one line") });
    expect(await threads(["post", T], { "reply-to": "msg_a", message: "x".repeat(32 * 1024) })).toBe(1);
    expect(json().error).toMatchObject({ state: "invalid_request", message: expect.stringContaining("32 KiB") });
    expect(await threads(["new"], { hosted: true, name: "n", summary: "s", message: "x".repeat(32 * 1024) })).toBe(1);
    expect(json().error.state).toBe("invalid_request");
    expect(calls).toEqual([]);
  });
});

describe("threads new --hosted and threads ack", () => {
  it("opens a hosted Thread with one opening Note", async () => {
    serve({ "POST /api/v1/threads": "thread-opened" });
    expect(await threads(["new"], { hosted: true, name: "New plan", summary: "One line", message: "Opening.", "post-id": "msg_cli_opening" })).toBe(0);
    expect(json()).toMatchObject({ schema: "ideaspaces.hosted-thread.new.v1", thread_id: T, post: { id: "msg_cli_opening", seq: 1 } });
    expect(JSON.parse(calls[0].body!)).toEqual({ note: "---\nid: msg_cli_opening\nkind: post\nname: New plan\nsummary: One line\n---\n\nOpening.\n" });
    expect(await threads(["new"], { hosted: true, name: "No summary", message: "x" })).toBe(1);
    expect(json().error.message).toContain("--summary is required");
  });

  it("acks by cursor or by seq, exactly one", async () => {
    serve({ [`GET /api/v1/threads/${T}`]: "thread-head", [`GET /api/v1/threads/${T}/posts`]: "thread-posts-latest", [`POST /api/v1/threads/${T}/ack`]: "ack" });
    expect(await threads(["open", T], { limit: "2" })).toBe(0);
    const cursor = json().cursor;
    expect(await threads(["ack", T], { cursor })).toBe(0);
    expect(json()).toEqual({ schema: "ideaspaces.hosted-thread.ack.v1", thread_id: T, read_seq: 6 });
    expect(calls.at(-1)!.body).toBe(JSON.stringify({ seq: 6 }));
    expect(await threads(["ack", T], { seq: "4" })).toBe(0);
    expect(calls.at(-1)!.body).toBe(JSON.stringify({ seq: 4 }));
    const sent = calls.length;
    expect(await threads(["ack", T], {})).toBe(1);
    expect(await threads(["ack", T], { cursor, seq: "4" })).toBe(1);
    expect(await threads(["ack", "x_short"], { seq: "1" })).toBe(1); // malformed id refuses before any request
    expect(calls.length).toBe(sent);
  });
});

describe("host mode: the token comes only from --token-fd", () => {
  function tokenFile(content: string): number {
    const file = join(home, "token.json");
    writeFileSync(file, content, { mode: 0o600 });
    return openSync(file, "r");
  }

  beforeEach(() => {
    vi.stubEnv("IDEASPACES_AUTH", "host");
    vi.stubEnv("IS_API_KEY", "env-key-must-not-be-used");
    vi.stubEnv("IS_API_URL", "https://env-url-must-not-be-used.test");
  });

  it("without the fd, every hosted verb refuses, calls nothing, and leaves the terminal's sign-in alone", async () => {
    const before = statSync(credentials).mtimeMs;
    expect(await vaultsCommand.run([], {}, JSON_FLAGS).catch((e) => e)).toBeInstanceOf(HostAuthRefusal);
    for (const [args, flags] of [[["list"], { hosted: true }], [["open", T], {}], [["post", T], { "reply-to": "msg_a", message: "x" }], [["ack", T], { seq: "1" }], [["new"], { hosted: true, name: "n", summary: "s", message: "m" }]] as const) {
      expect(await threads([...args], { ...flags })).toBe(1);
      expect(stderr).toContain("IDEASPACES_AUTH=host");
    }
    expect(calls).toEqual([]);
    expect(statSync(credentials).mtimeMs).toBe(before);
  });

  it("with the fd, spends exactly that token at its service, never IS_API_KEY, IS_API_URL or the stored login", async () => {
    const before = statSync(credentials).mtimeMs;
    const fd = tokenFile(JSON.stringify({ api_url: "http://127.0.0.1:9", access_token: HOST_KEY }));
    takeTokenFd(String(fd), "threads");
    expect(() => fstatSync(fd)).toThrow(/EBADF/); // read once, then closed: nothing started later can inherit it
    serve({ [`GET /api/v1/threads/${T}`]: "thread-head", [`GET /api/v1/threads/${T}/posts`]: "thread-posts-latest", "GET /api/v1/vaults": "vaults" });
    expect(await threads(["open", T])).toBe(0);
    expect(await vaultsCommand.run([], {}, JSON_FLAGS)).toBe(0);
    expect(calls.map((c) => [c.url.origin, c.auth])).toEqual([["http://127.0.0.1:9", `Bearer ${HOST_KEY}`], ["http://127.0.0.1:9", `Bearer ${HOST_KEY}`], ["http://127.0.0.1:9", `Bearer ${HOST_KEY}`]]);
    expect(stdout + stderr).not.toContain(HOST_KEY);
    expect(statSync(credentials).mtimeMs).toBe(before);
    expect(readFileSync(credentials, "utf8")).toContain(TERMINAL_KEY);
  });

  it("does not widen any other remote command, nor a forged config", async () => {
    takeTokenFd(String(tokenFile(JSON.stringify({ api_url: SERVICE, access_token: HOST_KEY }))), "threads");
    expect(() => loadConfig()).toThrow(HostAuthRefusal);
    await expect(fetchAuthMe({ apiUrl: SERVICE, apiKey: "other", host: true })).rejects.toBeInstanceOf(HostAuthRefusal);
    await expect(fetchAuthMe({ apiUrl: SERVICE, apiKey: HOST_KEY })).rejects.toBeInstanceOf(HostAuthRefusal);
    expect(calls).toEqual([]);
  });

  it("reads a token once, refuses anything malformed without echoing it, and refuses the flag where it does not belong", () => {
    expect(() => readHostToken(tokenFile(`{"api_url": "${SERVICE}", "access_token": "${HOST_KEY}"`))).toThrow(HostTokenError);
    const caught = (() => { try { readHostToken(tokenFile(`not json ${HOST_KEY}`)); } catch (e) { return e as Error; } })()!;
    expect(caught.message).not.toContain(HOST_KEY);
    expect(() => readHostToken(tokenFile(JSON.stringify({ api_url: "http://api.example.test", access_token: HOST_KEY })))).toThrow(/HTTPS/);
    expect(() => readHostToken(tokenFile(JSON.stringify({ api_url: SERVICE, access_token: `${HOST_KEY} x` })))).toThrow(/malformed/);
    expect(() => readHostToken(tokenFile(JSON.stringify({ api_url: SERVICE, access_token: "a".repeat(9000) })))).toThrow(/8192 bytes/);
    expect(hostToken()).toBeNull();
    readHostToken(tokenFile(JSON.stringify({ api_url: `${SERVICE}/`, access_token: HOST_KEY })));
    expect(hostToken()).toEqual({ apiUrl: SERVICE, accessToken: HOST_KEY });
    expect(() => readHostToken(tokenFile("{}"))).toThrow(/read once/);
    forgetHostToken();
    const wrong = tokenFile("{}");
    expect(() => takeTokenFd(String(wrong), "pull")).toThrow(/only by `ideaspaces vaults`/);
    expect(() => fstatSync(wrong)).toThrow(/EBADF/);
    vi.stubEnv("IDEASPACES_AUTH", "");
    const outside = tokenFile("{}");
    expect(() => takeTokenFd(String(outside), "vaults")).toThrow(/only under IDEASPACES_AUTH=host/);
    expect(() => fstatSync(outside)).toThrow(/EBADF/);
  });
});

// The real process boundary: the bundle, an inherited pipe on fd 3, a loopback service.
const BUNDLE = resolve("bundle/ideaspaces.js");
describe.skipIf(!existsSync(BUNDLE))("host-run CLI over a real inherited fd (requires npm run build)", () => {
  function child(args: string[], env: NodeJS.ProcessEnv, token?: string) {
    const proc = spawn(process.execPath, [BUNDLE, ...args], { env, stdio: ["ignore", "pipe", "pipe", token === undefined ? "ignore" : "pipe"] });
    let out = ""; let err = ""; let fdClosedAt = 0;
    proc.stdout!.on("data", (d) => { out += d; });
    proc.stderr!.on("data", (d) => { err += d; });
    if (token !== undefined) {
      const pipe = proc.stdio[3] as Socket;
      // EOF here means every holder of the child's end closed it, the CLI and anything it started.
      pipe.on("end", () => { fdClosedAt = Date.now(); });
      pipe.resume();
      pipe.end(token);
    }
    const done = new Promise<number>((resolveExit) => proc.on("close", (code) => resolveExit(code ?? -1)));
    return { proc, done, out: () => out, err: () => err, fdClosedAt: () => fdClosedAt };
  }

  it("reads fd 3 once, closes it before the request, sends only that token, and prints no secret", async () => {
    const seen: Array<{ auth?: string; at: number }> = [];
    let closedBeforeRequest = false;
    let running: ReturnType<typeof child> | undefined;
    const server = createServer((req: IncomingMessage, res) => {
      seen.push({ auth: req.headers.authorization, at: Date.now() });
      closedBeforeRequest = (running?.fdClosedAt() ?? 0) > 0;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(fixture("vaults")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const env = { PATH: process.env.PATH, HOME: home, IDEASPACES_AUTH: "host", IS_API_KEY: "env-key-must-not-be-used", IS_API_URL: "https://env-url-must-not-be-used.test" };
    const args = ["vaults", "--json", "--token-fd", "3"];
    const before = statSync(credentials).mtimeMs;
    try {
      running = child(args, env, JSON.stringify({ api_url: `http://127.0.0.1:${port}`, access_token: HOST_KEY }));
      const code = await running.done;
      expect(running.err()).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(running.out())).toMatchObject({ schema: "ideaspaces.vaults.v1", personal: { handle: "ada" } });
      expect(seen.map((s) => s.auth)).toEqual([`Bearer ${HOST_KEY}`]);
      expect(closedBeforeRequest).toBe(true);
      expect(running.out() + running.err()).not.toContain(HOST_KEY);
      expect([...args, ...Object.values(env)].join(" ")).not.toContain(HOST_KEY); // never argv or env
      expect(statSync(credentials).mtimeMs).toBe(before);

      const refused = child(["vaults", "--json"], env);
      expect(await refused.done).toBe(1);
      expect(refused.err()).toContain("IDEASPACES_AUTH=host");
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 20_000);
});

describe("Inbox removal: all hosted operations use /threads", () => {
  const legacy = "x_0123456789abcdef01234567";
  it.each([legacy, T])("reads, replies, renames, closes and acknowledges %s without fallback", async (id) => {
    serve({
      [`GET /api/v1/threads/${id}`]: () => ({ status: 200, body: { ...fixture("thread-head"), thread_id: id } }),
      [`GET /api/v1/threads/${id}/posts`]: () => ({ status: 200, body: { posts: [] } }),
      [`POST /api/v1/threads/${id}/posts`]: call => {
        const note = call.body!;
        const msgId = /^id: (.+)$/m.exec(note)![1];
        return { status: 201, body: { ...fixture("thread-posts-latest").posts[0], thread_id: id, post_id: msgId, note } };
      },
      [`POST /api/v1/threads/${id}/ack`]: () => ({ status: 200, body: { thread_id: id, read_seq: 1 } }),
    });
    expect(await threads(["read", id])).toBe(0);
    expect(await threads(["reply", id], { "reply-to": "msg_open", message: "Reply", "post-id": "msg_reply" })).toBe(0);
    expect(calls.at(-1)!.body).toContain("in_reply_to: msg_open");
    expect(await threads(["rename", id], { name: "New", summary: "Why", message: "Rationale" })).toBe(0);
    expect(calls.at(-1)!.body).toContain("kind: reframe");
    expect(calls.at(-1)!.body).toContain("name: New");
    expect(calls.at(-1)!.body).toContain("summary: Why");
    const before = calls.length;
    expect(await threads(["close", id], { message: "Done" })).toBe(0);
    expect(json().preview).toBe(true);
    expect(calls.length).toBe(before);
    expect(await threads(["close", id], { message: "Done", "post-id": "msg_close" }, { ...JSON_FLAGS, yes: true })).toBe(0);
    expect(calls.at(-1)!.body).toContain("kind: closure");
    expect(await threads(["ack", id], { seq: "1" })).toBe(0);
    expect(calls.every(c => c.url.pathname.startsWith("/api/v1/threads/"))).toBe(true);
    const sent = calls.length;
    expect(await threads(["reply", id], { "reply-to": "n_0123456789abcdef01234567", message: "Old parent" })).toBe(1);
    expect(json().error.message).toContain("msg_");
    expect(calls).toHaveLength(sent);
  });
  it("starts with a recipient and a Map on the opening Note, not an exchange selection", async () => {
    const map = { roots: [], members: [{ address: "https://example.org/context", depth: "summary", disclosure: { name: "Context", summary: "Observed link" } }] };
    serve({ "POST /api/v1/threads": call => {
      const body = JSON.parse(call.body!);
      expect(body.recipients).toEqual(["@ada"]);
      expect(body.note).toContain("map:");
      return { status: 201, body: { ...fixture("thread-posts-latest").posts[0], thread_id: T, post_id: "msg_open", seq: 1, note: body.note } };
    } });
    expect(await threads(["send", "@ada"], { name: "Question", summary: "Why", message: "Hello", map: JSON.stringify(map), "post-id": "msg_open" })).toBe(0);
    expect(calls.map(path)).toEqual(["POST /api/v1/threads"]);
  });
  it("accepts mixed legacy and new ids in a list page and keeps web Unread counts", async () => {
    serve({ "GET /api/v1/threads": () => ({ status: 200, body: { threads: [{ ...fixture("threads-page-1").threads[0], thread_id: legacy }, fixture("threads-page-1").threads[1]], next_cursor: null } }) });
    expect(await threads(["list"], { hosted: true, unread: true })).toBe(0);
    expect(json().threads).toMatchObject([{ id: legacy, unread_count: 2, read_seq: 4, last_seq: 6 }]);
  });
  it.each(["posts", "expand", "add"])("retires %s instead of rebuilding it", async verb => {
    expect(await threads([verb, legacy])).toBe(1);
    expect(calls).toEqual([]);
  });
});

it("requires the service Map disclosure profile before sending, never fabricating observed fields", async () => {
  expect(await threads(["new"], { hosted: true, name: "Map", summary: "Why", message: "Opening", map: JSON.stringify({ roots: [], members: [{ address: "https://example.org", depth: "summary" }] }) })).toBe(1);
  expect(json().error.message).toContain("authored disclosure");
  expect(calls).toEqual([]);
});

describe("review regressions and hosted validation", () => {
  it("refuses bare --map, duplicate/invalid/too many recipients without a request", async () => {
    const base = { hosted: true, name: "Question", summary: "Why", message: "Hello" };
    expect(await threads(["new"], { ...base, map: true })).toBe(1);
    expect(json().error.message).toContain("--map");
    for (const recipients of ["not a handle", "@one,@ONE", Array.from({length:17}, (_,i)=>`@p${i}`).join(",")]) {
      expect(await threads(["new"], { ...base, recipients })).toBe(1);
      expect(json().error.message).toContain("--recipients");
    }
    expect(calls).toEqual([]);
  });
  it("refuses hosted paging when signed out, not silently dropping it", async () => {
    rmSync(credentials);
    expect(await threads(["list"], { limit: "10" })).toBe(1);
    expect(json().error.state).toBe("signed_out");
    expect(calls).toEqual([]);
  });
  it("prints the preview post id to carry into confirmed close", async () => {
    expect(await threads(["close", T], { message: "Done", "post-id": "msg_close_stable" }, TEXT_FLAGS)).toBe(0);
    expect(stdout).toContain("--yes --post-id msg_close_stable");
    expect(calls).toEqual([]);
  });
});

it("advertises the hosted route without auth or a remote call", async () => {
  rmSync(credentials);
  expect(await threads(["capabilities"])).toBe(0);
  expect(json()).toEqual({ schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: false });
  expect(calls).toEqual([]);
});

it("new passes multiple recipients alongside the exact opening Note", async () => {
  serve({ "POST /api/v1/threads": call => {
    const body = JSON.parse(call.body!);
    expect(body.recipients).toEqual(["@ada", "reader@example.org"]);
    expect(body.note).toContain("id: msg_multiple");
    expect(body.note).toContain("name: Question");
    expect(body.note).toContain("summary: Why");
    expect(body.note).toContain("Opening body");
    return { status: 201, body: { ...fixture("thread-posts-latest").posts[0], thread_id: T, post_id: "msg_multiple", seq: 1, note: body.note } };
  } });
  expect(await threads(["new"], { hosted: true, recipients: "@ada,reader@example.org", name: "Question", summary: "Why", message: "Opening body", "post-id": "msg_multiple" })).toBe(0);
  expect(calls.map(path)).toEqual(["POST /api/v1/threads"]);
});

it("close ambiguous-write guidance retains explicit confirmation", async () => {
  serve({ [`POST /api/v1/threads/${T}/posts`]: () => new Error("offline") });
  expect(await threads(["close", T], { message: "Done", "post-id": "msg_close_uncertain" }, { ...JSON_FLAGS, yes: true })).toBe(1);
  expect(json().error.message).toContain("--post-id msg_close_uncertain --yes");
});
it("a changed close confirmation is a conflict, not an implicit retry", async () => {
  serve({ [`POST /api/v1/threads/${T}/posts`]: () => ({ status: 409, body: { detail: "msg_ id already used with different text or actor" } }) });
  expect(await threads(["close", T], { message: "Changed", "post-id": "msg_close_existing" }, { ...JSON_FLAGS, yes: true })).toBe(1);
  expect(json().error.state).toBe("conflict");
  expect(json().error.message).toContain("same --post-id and --message");
  expect(calls).toHaveLength(1);
});

it("previews close with no credential and a versioned schema, without claiming authority", async () => {
  rmSync(credentials);
  expect(await threads(["close", T], { message: "Plan", "post-id": "msg_local_plan" })).toBe(0);
  expect(json()).toMatchObject({ schema: "ideaspaces.hosted-thread.close-preview.v1", preview: true, post_id: "msg_local_plan", access_checked: false });
  expect(calls).toEqual([]);
});
