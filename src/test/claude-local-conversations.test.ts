import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  claudeConfigDir,
  claudeProjectDir,
  claudeProjectSlug,
  claudeSessionFile,
  getClaudeConversation,
  isClaudeConversationId,
  listClaudeConversations,
  mintClaudeConversationId,
  parseClaudeSessionJsonl,
} from "../claude/local-conversations.js";

import {
  claudeConversationOps,
} from "../claude/local-conversation-ops.js";
import type { Output } from "../output.js";

const ID = "d0b2e296-c2b7-4fa4-8227-6390639ea756";

// A fixture mirroring Claude Code 2.1's real session JSONL (from the recorded
// write → read → "done" run behind the SDK's stream-json fixture), trimmed to
// the record kinds that matter and the bookkeeping kinds we must skip.
const FIXTURE = [
  `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-14T09:32:15.726Z","sessionId":"${ID}"}`,
  `{"parentUuid":null,"isSidechain":false,"cwd":"/home/user/space","sessionId":"${ID}","type":"user","message":{"role":"user","content":"Create the file notes/hello.md, read it back, then reply: done"},"uuid":"u1","timestamp":"2026-09-14T09:32:15.748Z"}`,
  `{"parentUuid":"u1","isSidechain":false,"type":"attachment","attachment":{"type":"hook_success"},"uuid":"a1","timestamp":"2026-09-14T09:32:15.747Z","sessionId":"${ID}"}`,
  `{"type":"last-prompt","lastPrompt":"Create the file …","leafUuid":"u1","sessionId":"${ID}"}`,
  `{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"}],"usage":{"input_tokens":10,"output_tokens":512}},"uuid":"as1","timestamp":"2026-09-14T09:32:19.782Z","sessionId":"${ID}"}`,
  `{"parentUuid":"as1","isSidechain":false,"type":"assistant","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Write","input":{"file_path":"/home/user/space/notes/hello.md","content":"hello from fixture"}}],"usage":{"input_tokens":10,"output_tokens":512}},"uuid":"as2","timestamp":"2026-09-14T09:32:20.573Z","sessionId":"${ID}"}`,
  `{"parentUuid":"as2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"File created successfully at: /home/user/space/notes/hello.md"}]},"uuid":"u2","timestamp":"2026-09-14T09:32:20.595Z","sessionId":"${ID}","toolUseResult":{"type":"create"}}`,
  `{"parentUuid":"u2","isSidechain":false,"type":"assistant","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/home/user/space/notes/hello.md"}}],"usage":{"input_tokens":10,"output_tokens":512}},"uuid":"as3","timestamp":"2026-09-14T09:32:21.230Z","sessionId":"${ID}"}`,
  `{"parentUuid":"as3","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"1\\thello from fixture","is_error":false}]},"uuid":"u3","timestamp":"2026-09-14T09:32:21.236Z","sessionId":"${ID}"}`,
  `{"parentUuid":"sub","isSidechain":true,"type":"assistant","message":{"id":"msg_side","role":"assistant","content":[{"type":"text","text":"subagent chatter"}]},"uuid":"side1","timestamp":"2026-09-14T09:32:21.300Z","sessionId":"${ID}"}`,
  `{"type":"ai-title","aiTitle":"notes/hello.md fixture","sessionId":"${ID}"}`,
  `{"parentUuid":"u3","isSidechain":false,"type":"assistant","message":{"id":"msg_2","model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":8,"output_tokens":79}},"uuid":"as4","timestamp":"2026-09-14T09:32:22.689Z","sessionId":"${ID}"}`,
  `{"parentUuid":"as4","isSidechain":false,"type":"system","subtype":"stop_hook_summary","uuid":"s1","timestamp":"2026-09-14T09:32:22.722Z","sessionId":"${ID}"}`,
  `{"parentUuid":"as4","isSidechain":false,"type":"user","isMeta":true,"message":{"role":"user","content":"<injected context>"},"uuid":"meta1","timestamp":"2026-09-14T09:32:22.800Z","sessionId":"${ID}"}`,
].join("\n");

describe("Claude Code session addressing", () => {
  it("slugs the resolved cwd the way Claude Code does — every non-alphanumeric becomes a dash", () => {
    // On Windows the resolved path carries a drive letter (`C--Users-…`), as it does for Claude Code.
    const slug = claudeProjectSlug("/Users/me/github/space.v2");
    expect(slug).toMatch(/^[A-Za-z0-9-]+$/u);
    expect(slug).toMatch(/-Users-me-github-space-v2$/u);
    expect(claudeProjectSlug("/private/tmp/a_b c")).toMatch(/-private-tmp-a-b-c$/u);
    expect(claudeProjectSlug("/x/../y")).toBe(claudeProjectSlug("/y"));
  });

  it("reads the config dir from CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg");
    expect(claudeConfigDir({})).toMatch(/[\/\\]\.claude$/u);
    expect(claudeProjectDir("/ws", { CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "projects", claudeProjectSlug(resolve("/ws"))));
  });

  it("mints UUIDs and accepts only UUIDs as conversation ids", () => {
    expect(isClaudeConversationId(mintClaudeConversationId())).toBe(true);
    expect(isClaudeConversationId(ID)).toBe(true);
    expect(isClaudeConversationId("local-abc")).toBe(false);
    expect(isClaudeConversationId("../../settings.json")).toBe(false);
  });
});

describe("parseClaudeSessionJsonl", () => {
  const s = parseClaudeSessionJsonl(FIXTURE, "2026-09-14T09:32:30.000Z");

  it("reads id, title, preview, model, and visible-turn count", () => {
    expect(s.id).toBe(ID);
    expect(s.name).toBe("notes/hello.md fixture");
    expect(s.preview).toBe("Create the file notes/hello.md, read it back, then reply: done");
    expect(s.modelTier).toBe("claude-haiku-4-5-20251001");
    expect(s.messageCount).toBe(3); // user prompt + two API messages
    expect(s.updatedAt).toBe("2026-09-14T09:32:22.689Z");
  });

  it("folds one API message's block records into one assistant entry with its tool calls", () => {
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    const first = s.messages[1];
    expect(first.content).toBe("");
    expect(first.tool_calls).toEqual([
      { id: "toolu_1", name: "Write", args: { file_path: "/home/user/space/notes/hello.md", content: "hello from fixture" } },
      { id: "toolu_2", name: "Read", args: { file_path: "/home/user/space/notes/hello.md" } },
    ]);
    expect(first.usage).toEqual({ input_tokens: 10, output_tokens: 512 });
    expect(s.messages[4]).toMatchObject({ role: "assistant", content: "done" });
  });

  it("names tool results from the call they answer", () => {
    expect(s.messages[2]).toMatchObject({ role: "tool", tool_call_id: "toolu_1", tool_name: "Write", is_error: false });
    expect(s.messages[3]).toMatchObject({ role: "tool", tool_call_id: "toolu_2", tool_name: "Read", content: "1\thello from fixture" });
  });

  it("skips sidechain, meta, and bookkeeping records", () => {
    const text = s.messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("subagent chatter");
    expect(text).not.toContain("injected context");
  });

  it("falls back to a compaction summary for the name when there is no ai-title", () => {
    const old = parseClaudeSessionJsonl(`{"type":"summary","summary":"Older session","leafUuid":"x"}\n{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-01-01T00:00:00.000Z","sessionId":"${ID}"}`, "t");
    expect(old.name).toBe("Older session");
  });

  it("tags Claude Code command and command-output records with kind, name, and args", () => {
    const jsonl = [
      `{"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args></command-args>"},"timestamp":"2026-09-22T10:00:00.000Z","sessionId":"${ID}"}`,
      `{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted</local-command-stdout>"},"timestamp":"2026-09-22T10:00:05.000Z","sessionId":"${ID}"}`,
      `{"type":"user","message":{"role":"user","content":"<command-name>/review</command-name><command-args>src/app.ts</command-args>"},"timestamp":"2026-09-22T10:01:00.000Z","sessionId":"${ID}"}`,
      `{"type":"user","message":{"role":"user","content":"hello world"},"timestamp":"2026-09-22T10:02:00.000Z","sessionId":"${ID}"}`,
    ].join("\n");
    const parsed = parseClaudeSessionJsonl(jsonl, "t");
    expect(parsed.messages).toMatchObject([
      { role: "user", kind: "command", command: "/compact" },
      { role: "user", kind: "command-output", content: "<local-command-stdout>Compacted</local-command-stdout>" },
      { role: "user", kind: "command", command: "/review", args: "src/app.ts" },
      { role: "user", content: "hello world" },
    ]);
    expect(parsed.messages[3].kind).toBeUndefined();
    expect(parsed.preview).toBe("hello world");
  });
});

describe("Claude conversations on disk", () => {
  let cfg: string;
  let env: NodeJS.ProcessEnv;
  const ctx = "/home/user/space";

  beforeEach(async () => {
    cfg = await mkdtemp(join(tmpdir(), "claude-cfg-"));
    env = { CLAUDE_CONFIG_DIR: cfg };
    const dir = claudeProjectDir(ctx, env);
    await mkdir(join(dir, ID), { recursive: true }); // the session's subagent folder — not a session
    await writeFile(join(dir, `${ID}.jsonl`), FIXTURE);
    await writeFile(join(dir, "11111111-1111-4111-8111-111111111111.jsonl"), `{"type":"user","message":{"role":"user","content":"Second"},"timestamp":"2026-09-15T00:00:00.000Z","sessionId":"11111111-1111-4111-8111-111111111111"}\n`);
    await writeFile(join(dir, "22222222-2222-4222-8222-222222222222.jsonl"), `{"type":"queue-operation","sessionId":"22222222-2222-4222-8222-222222222222"}\n`);
    await writeFile(join(dir, "notes.jsonl"), "{}\n");
  });
  afterEach(async () => {
    await rm(cfg, { recursive: true, force: true });
  });

  it("finds a session file by id inside the project dir only", () => {
    expect(claudeSessionFile(ctx, ID, env)).toBe(join(claudeProjectDir(ctx, env), `${ID}.jsonl`));
    expect(claudeSessionFile(ctx, "33333333-3333-4333-8333-333333333333", env)).toBeNull();
    expect(claudeSessionFile("/elsewhere", ID, env)).toBeNull();
  });

  it("get returns the ConversationDetail shape, or an empty one for an unsent id", () => {
    const d = getClaudeConversation(ctx, ID, env);
    expect(d).toMatchObject({ conversation_id: ID, repo_id: ctx, name: "notes/hello.md fixture", turn_count: 3, model_tier: "claude-haiku-4-5-20251001", active_turn: null });
    expect(d.history).toHaveLength(5);
    const fresh = mintClaudeConversationId();
    expect(getClaudeConversation(ctx, fresh, env)).toEqual({ conversation_id: fresh, repo_id: ctx, name: "", history: [], active_turn: null });
  });

  it("list returns sessions with a visible turn, newest first, ignoring non-session files", () => {
    const { conversations, total } = listClaudeConversations(ctx, env);
    expect(total).toBe(2);
    expect(conversations.map((c) => c.conversation_id)).toEqual(["11111111-1111-4111-8111-111111111111", ID]);
    expect(conversations[1]).toMatchObject({ name: "notes/hello.md fixture", message_count: 3, status: "idle" });
    expect(listClaudeConversations("/never", env)).toEqual({ conversations: [], total: 0 });
  });
});

describe("claudeConversationOps validations", () => {
  function testOutput(errors: string[]): Output {
    return { error: (m: string) => errors.push(m) } as unknown as Output;
  }

  it("send rejects invalid --autocompact", async () => {
    const errors: string[] = [];
    const code = await claudeConversationOps.send(
      { message: "hi", conversation: ID, autocompact: "50k" },
      testOutput(errors),
    );
    expect(code).toBe(1);
    expect(errors[0]).toContain('Invalid --autocompact "50k"');
  });

  it("compact requires a conversation id", async () => {
    const errors: string[] = [];
    const code = await claudeConversationOps.compact!({}, testOutput(errors));
    expect(code).toBe(1);
    expect(errors[0]).toContain("A conversation id is required: --conversation <uuid>");
  });

  it("compact rejects non-UUID conversation id", async () => {
    const errors: string[] = [];
    const code = await claudeConversationOps.compact!({ conversation: "not-a-uuid" }, testOutput(errors));
    expect(code).toBe(1);
    expect(errors[0]).toContain('A Claude Code conversation id is a UUID; got "not-a-uuid"');
  });

  it("compact rejects invalid auth mode", async () => {
    const errors: string[] = [];
    const code = await claudeConversationOps.compact!(
      { conversation: ID, "claude-auth": "invalid" },
      testOutput(errors),
    );
    expect(code).toBe(1);
    expect(errors[0]).toContain('Invalid auth mode "invalid"');
  });
});
