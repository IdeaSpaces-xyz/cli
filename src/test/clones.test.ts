import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadSpacesMock } = vi.hoisted(() => ({ loadSpacesMock: vi.fn() }));

vi.mock("../auth/spaces.js", () => ({
  loadSpaces: loadSpacesMock,
  isUnpublishedForkRecord: (record: { kind?: string }) => record.kind === "unpublished_fork",
}));

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
      state: "hosted",
      repo_id: "r1",
      root_node_id: null,
      slug: "notes",
      namespace: "alice",
    });
  });

  it("lists an unpublished local fork without a fake destination", async () => {
    loadSpacesMock.mockReturnValue({
      "/Users/a/guide": {
        kind: "unpublished_fork",
        root_node_id: "n_0123456789abcdef01234567",
        name: "Guide",
        source_root_node_id: "n_ffffffffffffffffffffffff",
        source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
        source_baseline_initialized: true,
      },
    });

    const code = await clonesCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(stdout()).clones[0]).toEqual({
      path: "/Users/a/guide",
      state: "unpublished_fork",
      repo_id: null,
      root_node_id: "n_0123456789abcdef01234567",
      name: "Guide",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
    });
  });

  it("shows an empty-state hint when there are no clones", async () => {
    loadSpacesMock.mockReturnValue({});

    const code = await clonesCommand.run([], {}, HUMAN_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("No local clones");
  });
});
