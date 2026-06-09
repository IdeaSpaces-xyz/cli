import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadSpacesMock } = vi.hoisted(() => ({ loadSpacesMock: vi.fn() }));

vi.mock("../auth/spaces.js", () => ({ loadSpaces: loadSpacesMock }));

const { clonesCommand } = await import("../commands/clones.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let originalOut: typeof process.stdout.write;

beforeEach(() => {
  loadSpacesMock.mockReset();
  stdoutChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
});

const stdout = () => stdoutChunks.join("");

describe("clones", () => {
  it("lists local clones as JSON", async () => {
    loadSpacesMock.mockReturnValue({
      "/Users/a/notes": { repo_id: "r1", slug: "notes", namespace: "alice" },
    });

    const code = await clonesCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(stdout()).clones[0]).toEqual({
      path: "/Users/a/notes",
      repo_id: "r1",
      slug: "notes",
      namespace: "alice",
    });
  });

  it("shows an empty-state hint when there are no clones", async () => {
    loadSpacesMock.mockReturnValue({});

    const code = await clonesCommand.run([], {}, HUMAN_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("No local clones");
  });
});
