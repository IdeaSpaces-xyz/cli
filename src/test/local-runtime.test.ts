import { describe, it, expect } from "vitest";
import { composeLocalConversationOps, selectLocalRuntime } from "../local/runtime.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import type { Output } from "../output.js";

function ops(tag: string, calls: string[]): LocalConversationOps {
  return {
    send: async () => { calls.push(`${tag}:send`); return 0; },
    createNew: () => { calls.push(`${tag}:new`); return 0; },
    get: () => { calls.push(`${tag}:get`); return 0; },
    list: () => { calls.push(`${tag}:list`); return 0; },
  };
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
    const composed = composeLocalConversationOps({ pi: ops("pi", calls), claude: ops("claude", calls) });
    const out = output([]);
    await composed.send({ runtime: "claude" }, out);
    composed.createNew({ runtime: "claude" }, out);
    composed.get({}, out);
    composed.list({ runtime: "pi" }, out);
    expect(calls).toEqual(["claude:send", "claude:new", "pi:get", "pi:list"]);
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
