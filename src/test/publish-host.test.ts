/**
 * `publish` under IDEASPACES_AUTH=host (an app's "publish privately"): the host's token on a descriptor, a loopback
 * service for the API, and a real `git http-backend` behind it, so the push is Git's own and the header is what Git sent.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalFlags } from "../types.js";

const TOKEN = "dsk_host_publish_only_in_the_push";
const ROOT_ID = `n_${"a".repeat(24)}`;
const flags = (yes = true): GlobalFlags => ({ json: true, quiet: true, yes, help: false });

let tmp: string;
let originalCwd: string;
const SERVICE = fileURLToPath(new URL("./fixtures/host-publish-service.mjs", import.meta.url));
let service: ChildProcess | undefined;
let port: number;
let log: string;
let stdout: string;
/** Every request the service saw since the last reset, as it logged them. */
const seen = (): Array<{ method: string; path: string; auth: string | null }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const resetSeen = () => writeFileSync(log, "");
/** The loopback service in its own process; `createStatus` other than 200 refuses POST /repos with it. */
async function start(createStatus = "200") {
  service?.kill();
  service = spawn(process.execPath, [SERVICE, tmp, log, createStatus], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise<number>((resolve) => service!.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** The folder an app publishes: an Agreement that declares its root id, one Note, committed by a placeholder identity. */
function folder(name = "research", withId = true): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "_agent"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.name", "Idea Explorer");
  git(dir, "config", "user.email", "placeholder@idea-explorer.local");
  writeFileSync(join(dir, "_agent/agreement.md"), `---\nname: Agreement — Research\nsummary: Research.\n${withId ? `root_node_id: ${ROOT_ID}\n` : ""}---\n# Research\n`);
  writeFileSync(join(dir, "pricing.md"), "---\nname: Pricing\nsummary: Pricing in small councils.\n---\nThe plan.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Research");
  return dir;
}
beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "is-cli-host-publish-")));
  originalCwd = process.cwd();
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("IDEASPACES_AUTH", "host");
  vi.stubEnv("IS_API_KEY", "env-key-must-not-be-used");
  vi.stubEnv("IS_GIT_URL", "file:///must-not-be-used");
  vi.resetModules();
  stdout = "";
  log = join(tmp, "requests.jsonl");
  resetSeen();
  await start();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  service?.kill();
  service = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

/** One host publish in `dir`, with the token passed on a descriptor as the app passes it. */
async function publish(dir: string, yes = true) {
  const file = join(tmp, `token-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify({ api_url: `http://127.0.0.1:${port}`, access_token: TOKEN }), { mode: 0o600 });
  vi.resetModules(); // the token is read once per process, as an app's one call
  const { takeTokenFd } = await import("../host-token-flag.js");
  takeTokenFd(String(openSync(file, "r")), "publish");
  process.chdir(dir);
  const { publishCommand } = await import("../commands/publish.js");
  stdout = "";
  const code = await publishCommand.run([], {}, flags(yes));
  return { code, answer: JSON.parse(stdout.trim()) };
}

describe("publish in host mode", () => {
  it("creates the repo with the committed identity and pushes it, with the token only in the push's header", async () => {
    const dir = folder();
    const before = git(dir, "rev-parse", "HEAD");
    const { code, answer } = await publish(dir);
    expect(code, JSON.stringify(answer)).toBe(0);
    expect(answer).toMatchObject({ status: "published", private: true, with_history: true, root_node_id: ROOT_ID, commit_added: true });
    // The API on Bearer, Git on Basic with the same token, and nothing went anywhere else.
    const api = seen().filter((s) => !s.path.startsWith("/repos/"));
    expect(api.map((s) => [s.method, s.path, s.auth])).toEqual([["GET", "/auth/me", `Bearer ${TOKEN}`], ["POST", "/api/v1/repos", `Bearer ${TOKEN}`]]);
    const pushes = seen().filter((s) => s.path.startsWith(`/repos/${ROOT_ID}.git/`));
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((s) => s.auth === `Basic ${Buffer.from(`ideaspaces:${TOKEN}`).toString("base64")}`)).toBe(true);
    // What landed is the folder's history plus one commit under the person; nothing was rewritten.
    const served = join(tmp, "served/repos", `${ROOT_ID}.git`);
    expect(git(served, "rev-parse", "refs/heads/main")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(dir, "rev-parse", "HEAD~1")).toBe(before);
    expect(git(dir, "log", "-1", "--format=%ae|%an")).toBe("person:anna@ideaspaces|Anna Bērziņa");
    expect(git(dir, "config", "user.email")).toBe("placeholder@idea-explorer.local");
    // The origin carries no credential, and ~/.ideaspaces is untouched.
    expect(git(dir, "remote", "get-url", "origin")).toBe(`http://127.0.0.1:${port}/repos/${ROOT_ID}.git`);
    expect(spawnSync("git", ["-C", dir, "config", "--get-regexp", "extraheader"], { encoding: "utf-8" }).stdout).toBe("");
    expect(JSON.stringify(spawnSync("git", ["-C", dir, "config", "--list", "--show-origin"], { encoding: "utf-8" }).stdout)).not.toContain(TOKEN);
    expect(existsSync(join(tmp, ".ideaspaces"))).toBe(false);
  }, 60_000);

  it("runs none of the folder's hooks, under its own hooksPath or .git/hooks", async () => {
    const dir = folder();
    const marker = join(tmp, "hook-ran");
    for (const hooks of [join(dir, ".git/hooks"), join(tmp, "custom-hooks")]) {
      mkdirSync(hooks, { recursive: true });
      for (const name of ["pre-push", "pre-commit", "commit-msg", "post-commit", "reference-transaction"]) {
        writeFileSync(join(hooks, name), `#!/bin/sh\necho "$0" >> "${marker}"\nenv >> "${marker}"\n`);
        chmodSync(join(hooks, name), 0o755);
      }
    }
    git(dir, "config", "core.hooksPath", join(tmp, "custom-hooks"));
    const { code } = await publish(dir);
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("refuses a folder whose config rewrites URLs, before any request", async () => {
    const dir = folder();
    git(dir, "config", `url.https://evil.example/.insteadOf`, `http://127.0.0.1:${port}/`);
    const { code, answer } = await publish(dir);
    expect(code).toBe(1);
    expect(answer).toMatchObject({ schema: "ideaspaces.hosted.error.v1", error: { code: "redirected" } });
    expect(seen()).toEqual([]);
    const pushOnly = folder("research-2");
    git(pushOnly, "config", `url.https://evil.example/.pushInsteadOf`, "http://");
    expect((await publish(pushOnly)).answer.error.code).toBe("redirected");
    expect(seen()).toEqual([]);
  }, 60_000);

  it("answers already for a published folder and pushes nothing", async () => {
    const dir = folder();
    expect((await publish(dir)).code).toBe(0);
    resetSeen();
    const again = await publish(dir);
    expect(again.code).toBe(0);
    expect(again.answer).toMatchObject({ status: "already", root_node_id: ROOT_ID });
    expect(seen()).toEqual([]);
  }, 60_000);

  it("names each refusal by code: no --yes, the publishing plan, another origin", async () => {
    const dir = folder();
    expect((await publish(dir, false)).answer).toMatchObject({ error: { code: "not_confirmed" } });
    await start("402");
    const plan = await publish(dir);
    expect(plan.answer).toMatchObject({ error: { code: "subscription", state: "forbidden" } });
    expect(seen().some((s) => s.path.startsWith("/repos/"))).toBe(false);
    const other = folder("other");
    git(other, "remote", "add", "origin", "https://github.com/someone/other.git");
    expect((await publish(other)).answer).toMatchObject({ error: { code: "origin", state: "conflict" } });
  }, 60_000);

  it("never reads IS_GIT_URL, IS_API_KEY or a stored login", async () => {
    mkdirSync(join(tmp, ".ideaspaces"), { recursive: true });
    writeFileSync(join(tmp, ".ideaspaces/credentials.json"), JSON.stringify({ api_url: "https://stored.test", api_key: "stored-key-must-not-be-used" }));
    const dir = folder();
    const { code } = await publish(dir);
    expect(code).toBe(0);
    expect(seen().every((s) => !String(s.auth).includes("must-not-be-used") && !String(s.auth).includes("stored-key"))).toBe(true);
    expect(existsSync(join(tmp, ".ideaspaces/spaces.json"))).toBe(false);
  }, 60_000);
});

describe("the push child's environment", () => {
  it("turns off global and system config, helpers, hooks, prompts and traces, and adds only what it's given", async () => {
    vi.stubEnv("GIT_TRACE", "1");
    vi.stubEnv("GIT_CURL_VERBOSE", "1");
    vi.stubEnv("GIT_ASKPASS", "/tmp/x");
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'url.x.insteadof'='y'");
    const { isolatedGitEnv } = await import("../commands/publish-host.js");
    const env = isolatedGitEnv([["http.https://git.test/repos/n_x.git.extraHeader", "Authorization: Basic x"]]);
    expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    for (const key of ["GIT_TRACE", "GIT_CURL_VERBOSE", "GIT_ASKPASS", "GIT_CONFIG_PARAMETERS"]) expect(env[key]).toBeUndefined();
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toEqual([["credential.helper", ""], ["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["protocol.allow", "never"], ["protocol.https.allow", "always"],
      ["http.https://git.test/repos/n_x.git.extraHeader", "Authorization: Basic x"]]);
  });
});
