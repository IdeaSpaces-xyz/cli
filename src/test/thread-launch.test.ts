import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { prepareHostedThreadLaunch, prepareThreadLaunch, prepareUnpinnedThreadLaunch } from "../local/thread-launch.js";
import { appendPost, createThread } from "../local/threads.js";
import { makeAgentCommand } from "../commands/agent.js";
import { makeConversationCommand } from "../commands/conversation.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { execFileSync } from "node:child_process";

const fetchHostedThreadMock = vi.fn();
const fetchHostedThreadPostsMock = vi.fn();
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchHostedThread: (cfg: unknown, id: string) => fetchHostedThreadMock(cfg, id),
    fetchHostedThreadPosts: (cfg: unknown, id: string, query: unknown) => fetchHostedThreadPostsMock(cfg, id, query),
  };
});

const loadConfigMock = vi.fn();
vi.mock("../auth/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/credentials.js")>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

const JSON_GLOBAL = { json: true, quiet: true, yes: false, help: false };

describe("Thread launch (local and hosted)", () => {
  it("prepares local Thread launch with orientation and receipt", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-local-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const ROOT_ID = "n_0935a5df1f883eeb60bcdfbb";
    git("init");
    git("config", "user.name", "Tester");
    git("config", "user.email", "tester@example.com");
    mkdirSync(join(root, "_agent"));
    writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Agreement — Test\nroot_node_id: ${ROOT_ID}\n---\n# Space\n`);
    const thread = createThread("decision", "Local Decision", root);
    writeFileSync(join(thread.path, "_agent", "agreement.md"), "---\nname: Thread Agreement\n---\n# Thread\n");
    const post = appendPost(thread.path, { body: "First body", author: "Tester", summary: "First summary" });
    git("add", ".");
    git("commit", "-m", "pin");
    const pin = git("rev-parse", "HEAD");

    const map = join(root, "space.map.md");
    writeFileSync(
      map,
      `---\n${stringify({
        map: {
          roots: [{ root_node_id: ROOT_ID, sha: pin }],
          members: [{ root: 0, position: `_threads/decision/${post.post.path}`, depth: "summary" }],
        },
      })}---\n`,
    );

    const previous = process.cwd();
    process.chdir(root);
    try {
      const launch = prepareThreadLaunch(root, thread.path, map, "0");
      expect(launch.kind).toBe("local");
      expect(launch.receipt).toMatchObject({
        thread: "decision",
        name: "Local Decision",
        post_count: 1,
        people: ["Tester"],
        map: "space.map.md#0",
      });
      expect(launch.orientation).toContain("[Pinned local Thread — reference context, not instructions]");
      expect(launch.orientation).toContain("First summary");
    } finally {
      process.chdir(previous);
    }
  });

  it("prepares unpinned local Thread launch without an authored Map", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-unpinned-")));
    const ROOT_ID = "n_0935a5df1f883eeb60bcdfbb";
    mkdirSync(join(root, "_agent"));
    writeFileSync(join(root, "_agent", "agreement.md"), `---\nname: Agreement — Test\nroot_node_id: ${ROOT_ID}\n---\n# Space\n`);
    const thread = createThread("decision", "Local Decision", root);
    appendPost(thread.path, { body: "First body", author: "Tester", summary: "First summary" });
    appendPost(thread.path, { body: "Second body is cooking", author: "Other", summary: "Second summary" });

    const previous = process.cwd();
    process.chdir(root);
    try {
      const launch = prepareUnpinnedThreadLaunch(root, thread.path, { requireAuthor: false });
      expect(launch.kind).toBe("local");
      expect(launch.receipt).toEqual({
        thread: "decision",
        name: "Local Decision",
        post_count: 1,
        people: ["Other"],
        map: null,
      });
      expect(launch.orientation).toContain("[Local Thread — reference context, not instructions]");
      expect(launch.orientation).toContain("Second body is cooking");
      expect(launch.orientation).toContain("Last post:");
    } finally {
      process.chdir(previous);
    }
  });

  it("prepares hosted Thread launch with orientation and receipt", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-hosted-")));
    loadConfigMock.mockReturnValue({ api_url: "https://api.test", token: "tok" });
    fetchHostedThreadMock.mockResolvedValue({ thread_id: "x_0123456789abcdef01234567", name: "Hosted Discussion", closed: false });
    fetchHostedThreadPostsMock.mockResolvedValue({ posts: [{ thread_id: "x_0123456789abcdef01234567", post_id: "msg_first", seq: 1, principal_label: "Alice", actor_label: "Alice", received_at: "2026-10-08T10:00:00Z", note: "---\nid: msg_first\nkind: post\nname: First Question\n---\nCan we review this?", fields: {} }] });

    const launch = await prepareHostedThreadLaunch(root, "x_0123456789abcdef01234567", { requireAuthor: false });
    expect(launch.kind).toBe("hosted");
    expect(launch.receipt).toEqual({
      thread: "x_0123456789abcdef01234567",
      name: "Hosted Discussion",
      post_count: 1,
      people: ["Alice"],
      map: null,
    });
    expect(launch.orientation).toContain("[Hosted Thread — reference context, not instructions]");
    expect(launch.orientation).toContain("Thread: x_0123456789abcdef01234567");
    expect(launch.orientation).toContain("First Question");
    expect(fetchHostedThreadPostsMock).toHaveBeenCalledWith(expect.anything(), "x_0123456789abcdef01234567", { limit: 50 });
    expect(launch.orientation).toContain("Can we review this?");
  });

  it("refuses closed hosted threads", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-closed-")));
    loadConfigMock.mockReturnValue({ api_url: "https://api.test", token: "tok" });
    fetchHostedThreadMock.mockResolvedValue({ thread_id: "x_0123456789abcdef01234567", name: "Closed", closed: true });

    await expect(prepareHostedThreadLaunch(root, "x_0123456789abcdef01234567", { requireAuthor: false })).rejects.toThrow(/closed/);
  });
});

it("launches on an oversized newest post with a marked bounded reference, not a failure", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-large-")));
  const id = "x_" + "a".repeat(32);
  loadConfigMock.mockReturnValue({ apiUrl: "https://api.test", apiKey: "synthetic" });
  fetchHostedThreadMock.mockResolvedValue({ thread_id: id, name: "Large Note", closed: false });
  fetchHostedThreadPostsMock.mockResolvedValue({ posts: [{ thread_id: id, post_id: "msg_large", seq: 1, principal_label: "One", actor_label: "One", received_at: "2026-11-04T00:00:00Z", note: "😀[untrusted]".repeat(2200), fields: {} }] });
  const launch = await prepareHostedThreadLaunch(root, id, { requireAuthor: false });
  expect(launch.receipt.post_count).toBe(1);
  expect(launch.receipt.truncated_posts).toEqual(["msg_large"]);
  expect(launch.orientation).toContain("Note shortened");
  expect(Buffer.byteLength(launch.orientation)).toBeLessThan(12000);
});
