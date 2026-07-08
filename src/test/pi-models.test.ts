import { describe, it, expect } from "vitest";
import { trimModel } from "../commands/pi-models.js";

describe("trimModel (pi model → picker shape)", () => {
  it("builds a provider/id ref and maps thinking + image", () => {
    const m = trimModel({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15 },
    });
    expect(m.ref).toBe("anthropic/claude-sonnet-4-5");
    expect(m.name).toBe("Claude Sonnet 4.5");
    expect(m.reasoning).toBe(true);
    expect(m.image).toBe(true);
    expect(m.cost).toEqual({ input: 3, output: 15 });
  });

  it("defaults name to id, image false without image input, cost undefined when absent", () => {
    const m = trimModel({ id: "gpt-x", provider: "openai", input: ["text"] });
    expect(m.name).toBe("gpt-x");
    expect(m.image).toBe(false);
    expect(m.reasoning).toBe(false);
    expect(m.cost).toBeUndefined();
    expect(m.contextWindow).toBe(0);
  });
});
