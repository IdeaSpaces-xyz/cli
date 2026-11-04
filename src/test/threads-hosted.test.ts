import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadConfigMock, listHostedThreadsMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(), listHostedThreadsMock: vi.fn(),
}));
// Outside host mode, peekConfig is loadConfig.
vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock, peekConfig: loadConfigMock, isHostAuth: () => false }));
vi.mock("../auth/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/api.js")>(),
  listHostedThreads: listHostedThreadsMock,
}));
const { threadsCommand } = await import("../commands/threads.js");
const { createThread, appendPost } = await import("../local/threads.js");

const flags = { json: true, quiet: true, yes: false, help: false };
const id = "x_0123456789abcdef01234567";
const temp: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("merges local and hosted list rows, excluding access requests, while preserving hosted depth", async () => {
  const root = mkdtempSync(join(tmpdir(), "is-threads-list-")); temp.push(root);
  process.env.HOME = root;
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Test\nsummary: Test\n---\n");
  const local = createThread("decision", "Local decision", root);
  appendPost(local.path, { body: "Private local body", author: "Agent A" });
  loadConfigMock.mockReturnValue({ apiUrl: "https://example.test", apiKey: "test" });
  listHostedThreadsMock.mockImplementation((_config, query) => Promise.resolve(query.cursor ? { threads: [{ thread_id: "x_" + "f".repeat(32), name: "Second page", closed: false, unread_count: 3 }], next_cursor: null } : { threads: [{ thread_id: id, name: "Hosted decision", summary: "Hosted summary", closed: false, unread_count: 2, read_seq: 1, last_seq: 3 }], next_cursor: "second" }));
  const previous = process.cwd(); process.chdir(root);
  const stdout = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string) => { text += chunk; return true; }) as typeof process.stdout.write;
  async function list(options: Record<string, string | boolean>) {
    text = "";
    expect(await threadsCommand.run(["list"], options, flags)).toBe(0);
    return JSON.parse(text);
  }
  try {
    const together = await list({});
    expect(together.threads.map((row: { source: string }) => row.source)).toEqual(["local", "hosted", "hosted"]);
    expect(together.threads[1].id).toBe(id);
    expect(together.threads[1].unread_count).toBe(2);
    expect(together.threads[2].unread_count).toBe(3);
    const names = await list({ depth: "name" });
    expect(text).not.toContain("Hosted summary"); expect(text).not.toContain("Private local body");
    expect(names.threads[0].name).toBe("Local decision");
    expect(names.threads[1].unread_count).toBe(2);
    const full = await list({ depth: "full" });
    expect(full.threads[0].posts[0].body).toContain("Private local body");
    expect(full.threads[1].unread_count).toBe(2);
    const unread = await list({ new: true });
    expect(unread.threads).toHaveLength(3);
    expect(listHostedThreadsMock).toHaveBeenCalledWith(expect.anything(), { limit: 200, cursor: "second" });
  } finally { process.stdout.write = stdout; process.chdir(previous); }
});

it("refuses repeated service cursors instead of looping or claiming a complete hosted list", async () => {
  const root = mkdtempSync(join(tmpdir(), "is-threads-loop-")); temp.push(root);
  process.env.HOME = root;
  loadConfigMock.mockReturnValue({ apiUrl: "https://example.test", apiKey: "synthetic" });
  listHostedThreadsMock.mockResolvedValue({ threads: [], next_cursor: "same" });
  const previous = process.cwd(); process.chdir(root);
  const write = process.stderr.write; let errors = "";
  process.stderr.write = ((chunk: string) => { errors += chunk; return true; }) as typeof write;
  try {
    expect(await threadsCommand.run(["list"], { new: true }, flags)).toBe(1);
    expect(errors).toContain("repeated a Thread list cursor");
  } finally { process.stderr.write = write; process.chdir(previous); }
});

it("discards earlier hosted pages when a later page fails, retaining only healthy local rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "is-threads-partial-")); temp.push(root);
  process.env.HOME = root;
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent/agreement.md"), "---\nname: Test\nsummary: Test\n---\n");
  const local = createThread("local", "Local only", root); appendPost(local.path, { body: "One", author: "Agent" });
  loadConfigMock.mockReturnValue({ apiUrl: "https://example.test", apiKey: "synthetic" });
  listHostedThreadsMock.mockImplementation((_c, query) => query.cursor ? Promise.reject(new Error("offline")) : Promise.resolve({ threads: [{ thread_id: id, name: "Partial remote", closed: false, unread_count: 2 }], next_cursor: "more" }));
  const previous = process.cwd(); process.chdir(root);
  const out = process.stdout.write; const err = process.stderr.write; let text = "";
  process.stdout.write = ((chunk: string) => { text += chunk; return true; }) as typeof out;
  process.stderr.write = (() => true) as typeof err;
  try {
    expect(await threadsCommand.run(["list"], {}, flags)).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ hosted_checked: false, threads: [{ source: "local" }] });
    expect(JSON.parse(text).threads).toHaveLength(1);
    text = "";
    expect(await threadsCommand.run(["list"], { unread: true }, flags)).toBe(1);
    expect(JSON.parse(text).hosted_checked).toBe(false);
  } finally { process.stdout.write = out; process.stderr.write = err; process.chdir(previous); }
});

it("bounds fresh infinite service cursors with a visible incomplete-list error", async () => {
  const root = mkdtempSync(join(tmpdir(), "is-threads-bound-")); temp.push(root); process.env.HOME = root;
  loadConfigMock.mockReturnValue({ apiUrl: "https://example.test", apiKey: "synthetic" });
  let pages = 0;
  listHostedThreadsMock.mockImplementation(() => Promise.resolve({ threads: [], next_cursor: `page_${++pages}` }));
  const old = process.cwd(); process.chdir(root);
  const write = process.stderr.write; let error = "";
  process.stderr.write = ((s: string) => { error += s; return true; }) as typeof write;
  try {
    expect(await threadsCommand.run(["list"], {}, flags)).toBe(1);
    expect(pages).toBe(100);
    expect(error).toContain("No complete Unread list is claimed");
  } finally { process.stderr.write = write; process.chdir(old); }
});
