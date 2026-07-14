import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessionJsonl,
  mintConversationId,
  getLocalConversation,
  listLocalConversations,
  localSessionDir,
} from "../pi/local-conversations.js";

// A fixture mirroring pi's real v3 session JSONL (captured from a live run).
const FIXTURE = [
  `{"type":"session","version":3,"id":"conv1","timestamp":"2026-07-02T13:00:00.000Z","cwd":"/ctx"}`,
  `{"type":"model_change","id":"m","timestamp":"2026-07-02T13:00:00.500Z"}`,
  `{"type":"message","id":"a","parentId":"0","timestamp":"2026-07-02T13:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello there"}]}}`,
  `{"type":"message","id":"b","parentId":"a","timestamp":"2026-07-02T13:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"is_navigate","arguments":{"path":"."}}],"usage":{"totalTokens":10}}}`,
  `{"type":"message","id":"c","parentId":"b","timestamp":"2026-07-02T13:00:03.000Z","message":{"role":"toolResult","toolCallId":"tc1","toolName":"is_navigate","content":[{"type":"text","text":"space root: /ctx"}],"isError":false}}`,
  `{"type":"message","id":"d","parentId":"c","timestamp":"2026-07-02T13:00:04.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Hi!"}]}}`,
  `{"type":"session_info","id":"e","timestamp":"2026-07-02T13:00:05.000Z","name":"My chat"}`,
].join("\n");

describe("parseSessionJsonl", () => {
  const s = parseSessionJsonl(FIXTURE, "2026-07-02T13:00:09.000Z");

  it("reads id, name, preview, and visible-turn count", () => {
    expect(s.id).toBe("conv1");
    expect(s.name).toBe("My chat");
    expect(s.preview).toBe("Hello there");
    expect(s.messageCount).toBe(3); // user + 2 assistant (tool result not counted)
    expect(s.updatedAt).toBe("2026-07-02T13:00:04.000Z"); // last message activity
  });

  it("maps user / assistant(toolCall) / toolResult / assistant(text)", () => {
    expect(s.messages).toHaveLength(4);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "Hello there" });
    expect(s.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc1", name: "is_navigate", args: { path: "." } }],
    });
    expect(s.messages[2]).toMatchObject({
      role: "tool",
      content: "space root: /ctx",
      tool_call_id: "tc1",
      tool_name: "is_navigate",
      is_error: false,
    });
    // thinking dropped; text kept; no tool_calls
    expect(s.messages[3]).toMatchObject({ role: "assistant", content: "Hi!" });
    expect(s.messages[3].tool_calls).toBeUndefined();
  });
});

describe("mintConversationId", () => {
  it("mints a local- prefixed id", () => {
    expect(mintConversationId()).toMatch(/^local-/);
    expect(mintConversationId()).not.toBe(mintConversationId());
  });
});

describe("get / list over a context session dir", () => {
  let ctx: string;
  beforeEach(async () => {
    ctx = realpathSync(await mkdtemp(join(tmpdir(), "is-cli-lc-")));
    const dir = localSessionDir(ctx);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-07-02T13-00-00-000Z_conv1.jsonl"), FIXTURE);
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
  });

  it("getLocalConversation returns ConversationDetail from the session", () => {
    const d = getLocalConversation(ctx, "conv1");
    expect(d.conversation_id).toBe("conv1");
    expect(d.name).toBe("My chat");
    expect(d.history).toHaveLength(4);
    expect(d.active_turn).toBeNull();
    expect(d.turn_count).toBe(3);
  });

  it("getLocalConversation returns an empty detail for an unknown id", () => {
    const d = getLocalConversation(ctx, "local-nope");
    expect(d.history).toEqual([]);
    expect(d.name).toBe("");
  });

  it("listLocalConversations summarizes the context's sessions", () => {
    const { conversations, total } = listLocalConversations(ctx);
    expect(total).toBe(1);
    expect(conversations[0]).toMatchObject({
      conversation_id: "conv1",
      name: "My chat",
      message_count: 3,
      status: "idle",
    });
  });

  it("listLocalConversations is empty when the context has no sessions", () => {
    const empty = realpathSync;
    expect(listLocalConversations("/tmp/definitely-not-a-context-xyz")).toEqual({
      conversations: [],
      total: 0,
    });
    void empty;
  });
});
