import { afterEach, describe, expect, it, vi } from "vitest";

// Exercises the real streamConversationMessage against a fabricated SSE response,
// so the chunk-buffering / SSE-parsing (the tricky bit) is covered — not mocked.
import { streamConversationMessage, UnauthorizedError } from "../auth/api.js";

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };

// Build a streaming Response whose body emits `chunks` in order. Chunk
// boundaries are deliberately not aligned to SSE event boundaries.
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(repoId = "repo", convId = "c1"): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const e of streamConversationMessage(CFG, repoId, convId, { message: "hi" })) {
    out.push(e);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamConversationMessage", () => {
  it("parses events, buffering a JSON line split across chunk boundaries", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","conversation_id":"c1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"Hel', // split mid-JSON
      'lo"}\n\nevent: turn_complete\ndata: {"type":"turn_complete","result":{"workspace":{"created":["n1"],"modified":[],"deleted":[],"read":[],"mentioned":[]}}}\n\n',
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));

    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "turn_complete"]);
    expect(events[1].delta).toBe("Hello");
    expect((events[2].result as { workspace: { created: string[] } }).workspace.created).toEqual([
      "n1",
    ]);
  });

  it("handles CRLF separators and flushes a final event without a trailing blank line", async () => {
    const chunks = [
      'event: text_delta\r\ndata: {"type":"text_delta","delta":"a"}\r\n\r\n',
      'event: turn_complete\r\ndata: {"type":"turn_complete","result":{}}', // no trailing \n\n
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));

    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(["text_delta", "turn_complete"]);
  });

  it("skips keep-alive / non-data blocks", async () => {
    const chunks = [
      ": ping\n\n",
      'data: {"type":"text_delta","delta":"x"}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));

    const events = await collect();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text_delta");
  });

  it("throws on a non-OK status, surfacing the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(["nope"], 402)));
    await expect(collect()).rejects.toThrow(/402/);
  });

  it("maps a 401 to UnauthorizedError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(["no"], 401)));
    await expect(collect()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
