import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeTurn } from "../claude/local-agent.js";
import type { KeeperStreamEvent } from "@ideaspaces/sdk";

// A stand-in `claude` that speaks stream-json the way the recorded fixture
// does: init, a Write call and its result, a text delta, a success result.
// `hang` after the init lets the abort path be exercised.
const FAKE_CLAUDE = `
const args = process.argv.slice(2);
const id = args[args.indexOf("--resume") + 1] || args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let prompt = "";
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: id, model: "claude-fake", cwd: process.cwd() });
  if (prompt.includes("hang")) { setInterval(() => {}, 1000); return; }
  process.stderr.write("warning: prose on stderr\\n");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: process.cwd() + "/notes/a.md", content: "x" } }] } });
  require("node:fs").mkdirSync(process.cwd() + "/notes", { recursive: true });
  require("node:fs").writeFileSync(process.cwd() + "/notes/a.md", "x");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
  out({ type: "stream_event", event: { type: "message_start" } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "echo:" + prompt.trim() } } });
  out({ type: "result", subtype: "success", is_error: false, result: "echo:" + prompt.trim(), num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 2 } });
});
`;

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe.skipIf(process.platform === "win32")("runClaudeTurn against a stand-in claude", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-run-"));
    await writeFile(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    bin = join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    await chmod(bin, 0o755);
    await mkdir(join(dir, "space"), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(gen: AsyncGenerator<KeeperStreamEvent>): Promise<KeeperStreamEvent[]> {
    const out: KeeperStreamEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("streams a whole turn: prompt on stdin, tool call harvested, result closes it", async () => {
    const events = await collect(runClaudeTurn({
      repoPath: join(dir, "space"),
      message: "hello there",
      conversationId: ID,
      sessionExists: false,
      claudeBin: bin,
      modelTier: "fake",
    }));
    expect(events.map((e) => e.type)).toEqual(["message_start", "tool_start", "tool_result", "text_delta", "message_delta", "turn_complete"]);
    expect(events[0]).toEqual({ type: "message_start", conversation_id: ID, model_tier: "fake" });
    const done = events.at(-1) as Extract<KeeperStreamEvent, { type: "turn_complete" }>;
    expect(done.result.response).toBe("echo:hello there");
    expect(done.result.workspace.modified.map((p) => p.split("/").slice(-2).join("/"))).toEqual(["notes/a.md"]);
    expect(done.result.usage).toMatchObject({ input_tokens: 1, output_tokens: 2, cost_usd: 0.001, model_tier: "fake" });
  });

  it("kills the child and emits cancelled when aborted mid-turn", async () => {
    const controller = new AbortController();
    const gen = runClaudeTurn({
      repoPath: join(dir, "space"),
      message: "please hang",
      conversationId: ID,
      sessionExists: true,
      claudeBin: bin,
      signal: controller.signal,
    });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: "message_start", conversation_id: ID });
    controller.abort();
    const rest = await collect(gen);
    expect(rest).toEqual([{ type: "cancelled", reason: "aborted" }]);
  });

  it("reports a binary that cannot start as an error, not a hang", async () => {
    const events = await collect(runClaudeTurn({
      repoPath: join(dir, "space"),
      message: "hi",
      conversationId: ID,
      sessionExists: true,
      claudeBin: join(dir, "no-such-claude"),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error_type: "claude_exit" });
    expect((events[0] as { message: string }).message).toMatch(/Could not start .*no-such-claude/);
  });
});
