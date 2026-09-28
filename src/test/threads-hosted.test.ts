import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadConfigMock, fetchInboxMock, fetchExchangeMock, fetchSpaceThreadsMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(), fetchInboxMock: vi.fn(), fetchExchangeMock: vi.fn(), fetchSpaceThreadsMock: vi.fn(),
}));
vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/api.js")>(),
  fetchInbox: fetchInboxMock, fetchExchange: fetchExchangeMock, fetchSpaceThreads: fetchSpaceThreadsMock,
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
  fetchInboxMock.mockResolvedValue({ items: [
    { kind: "inquiry", exchange_id: id, latest_message: { name: "Hosted decision", summary: "Hosted summary" }, cursor: 0, latest_position: 1, message_count: 1 },
    { kind: "access_request", request_id: "r_test", latest_position: 1 },
  ] });
  fetchExchangeMock.mockResolvedValue({ exchange_id: id, target_node_id: "n_0123456789abcdef01234567", participants: [], cursor: 0,
    latest_position: 1, messages: [{ position: 1, name: "Hosted decision", summary: "Hosted summary", markdown: "Hosted body", author_ref: "person:user_1", actor_ref: "person:user_1" }] });
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
    expect(together.threads.map((row: { source: string }) => row.source)).toEqual(["local", "hosted"]);
    expect(together.threads[1].id).toBe(id);
    const names = await list({ depth: "name" });
    expect(text).not.toContain("Hosted summary"); expect(text).not.toContain("Private local body");
    expect(names.threads[0].name).toBe("Local decision");
    const full = await list({ depth: "full" });
    expect(full.threads[0].posts[0].body).toContain("Private local body");
    expect(full.threads[1].messages[0].markdown).toBe("Hosted body");
    expect(fetchExchangeMock).toHaveBeenCalledWith(expect.anything(), id);
  } finally { process.stdout.write = stdout; process.chdir(previous); }
});
