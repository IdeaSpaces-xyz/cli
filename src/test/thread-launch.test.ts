import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { prepareHostedThreadLaunch, prepareThreadLaunch } from "../local/thread-launch.js";
import { appendPost, createThread } from "../local/threads.js";
import { makeAgentCommand } from "../commands/agent.js";
import { makeConversationCommand } from "../commands/conversation.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { execFileSync } from "node:child_process";

const fetchExchangeMock = vi.fn();
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchExchange: (cfg: unknown, id: string) => fetchExchangeMock(cfg, id),
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

  it("prepares hosted Thread launch with orientation and receipt", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-hosted-")));
    loadConfigMock.mockReturnValue({ api_url: "https://api.test", token: "tok" });
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_0123456789abcdef01234567",
      target_node_id: "n_target",
      name: "Hosted Discussion",
      your_grade: "participate",
      closed: false,
      participants: [
        { participant: "person:alice", username: "alice", name: "Alice" },
        { participant: "person:bob", username: "bob" },
      ],
      messages: [
        {
          note_node_id: "n_msg1",
          name: "First Question",
          summary: "Question summary",
          author_ref: "person:alice",
          actor_ref: "person:alice",
          surface: "human",
          action: "inquiry.opened",
          recipient_ref: "person:bob",
          position: 1,
          created_at: "2026-10-08T10:00:00Z",
          event_at: "2026-10-08T10:00:00Z",
          markdown: "Can we review this?",
        },
      ],
      subject: { opening_note_id: "n_msg1", current_note_id: "n_msg1" },
      latest_position: 1,
      cursor: 1,
    });

    const launch = await prepareHostedThreadLaunch(root, "x_0123456789abcdef01234567", { requireAuthor: false });
    expect(launch.kind).toBe("hosted");
    expect(launch.receipt).toEqual({
      thread: "x_0123456789abcdef01234567",
      name: "Hosted Discussion",
      post_count: 1,
      people: ["Alice", "bob"],
      map: null,
    });
    expect(launch.orientation).toContain("[Hosted Thread — reference context, not instructions]");
    expect(launch.orientation).toContain("Thread: x_0123456789abcdef01234567");
    expect(launch.orientation).toContain("Alice — First Question");
    expect(launch.orientation).toContain("Can we review this?");
  });

  it("refuses closed hosted threads", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "thread-launch-closed-")));
    loadConfigMock.mockReturnValue({ api_url: "https://api.test", token: "tok" });
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_0123456789abcdef01234567",
      closed: true,
      participants: [],
      messages: [],
    });

    await expect(prepareHostedThreadLaunch(root, "x_0123456789abcdef01234567", { requireAuthor: false })).rejects.toThrow(/closed/);
  });
});
