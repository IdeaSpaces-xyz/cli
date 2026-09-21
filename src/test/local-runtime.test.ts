import { describe, it, expect } from "vitest";
import { composeLocalConversationOps, selectLocalRuntime } from "../local/runtime.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import type { Output } from "../output.js";

function ops(tag: string, calls: string[], supportsCompact = false): LocalConversationOps {
  const o: LocalConversationOps = {
    send: async () => { calls.push(`${tag}:send`); return 0; },
    createNew: () => { calls.push(`${tag}:new`); return 0; },
    get: () => { calls.push(`${tag}:get`); return 0; },
    list: () => { calls.push(`${tag}:list`); return 0; },
  };
  if (supportsCompact) {
    o.compact = async () => { calls.push(`${tag}:compact`); return 0; };
  }
  return o;
}

function output(errors: string[]): Output {
  return { error: (m: string) => errors.push(m) } as unknown as Output;
}

describe("selectLocalRuntime", () => {
  it("defaults to pi and honours --runtime", () => {
    expect(selectLocalRuntime({})).toBe("pi");
    expect(selectLocalRuntime({ runtime: "pi" })).toBe("pi");
    expect(selectLocalRuntime({ runtime: "claude" })).toBe("claude");
  });

  it("rejects an unknown or bare --runtime", () => {
    expect(() => selectLocalRuntime({ runtime: "gemini" })).toThrow(/Unknown local runtime "gemini"/);
    expect(() => selectLocalRuntime({ runtime: true })).toThrow(/Valid values: pi, claude/);
  });
});

describe("composeLocalConversationOps", () => {
  it("routes every verb to the runtime --runtime names", async () => {
    const calls: string[] = [];
    const composed = composeLocalConversationOps({
      pi: ops("pi", calls, false),
      claude: ops("claude", calls, true),
    });
    const out = output([]);
    await composed.send({ runtime: "claude" }, out);
    composed.createNew({ runtime: "claude" }, out);
    composed.get({}, out);
    composed.list({ runtime: "pi" }, out);
    await composed.compact!({ runtime: "claude" }, out);
    expect(calls).toEqual(["claude:send", "claude:new", "pi:get", "pi:list", "claude:compact"]);
  });

  it("reports an unsupported error when the runtime has no compact implementation", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const composed = composeLocalConversationOps({
      pi: ops("pi", calls, false),
      claude: ops("claude", calls, true),
    });
    const code = await composed.compact!({ runtime: "pi" }, output(errors));
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(errors[0]).toContain('Compaction is not supported by local runtime "pi"');
    expect(errors[0]).toContain("--runtime=claude");
  });

  it("reports an unknown runtime and exits 1 without touching any runtime", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const composed = composeLocalConversationOps({ pi: ops("pi", calls), claude: ops("claude", calls) });
    expect(await composed.send({ runtime: "nope" }, output(errors))).toBe(1);
    expect(composed.list({ runtime: "nope" }, output(errors))).toBe(1);
    expect(calls).toEqual([]);
    expect(errors[0]).toMatch(/Unknown local runtime "nope"/);
  });
});
