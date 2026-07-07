import { describe, expect, it } from "vitest";
import { isValidChangeId } from "@ideaspaces/sdk";
import { changeCommand, resolveHandle } from "../commands/change.js";
import type { GlobalFlags } from "../types.js";

const G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };

describe("resolveHandle", () => {
  it("reads --handle when it carries a string value", () => {
    expect(resolveHandle({ handle: "surface collapse" }, [])).toBe("surface collapse");
  });

  it("falls back to the first positional", () => {
    expect(resolveHandle({}, ["auth model"])).toBe("auth model");
  });

  it("prefers --handle over a positional", () => {
    expect(resolveHandle({ handle: "flag" }, ["positional"])).toBe("flag");
  });

  it("ignores a value-less --handle (boolean true) instead of stamping \"true\"", () => {
    // argv.ts yields boolean `true` for `--handle` as the last token; that must
    // not become the literal handle text "true".
    expect(resolveHandle({ handle: true }, [])).toBe("");
    expect(resolveHandle({ handle: true }, ["real"])).toBe("real");
  });

  it("is empty when nothing is given", () => {
    expect(resolveHandle({}, [])).toBe("");
  });
});

/** Capture process.stdout during `fn` and return what was written. */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((s: string) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = orig;
  }
  return chunks.join("");
}

describe("changeCommand", () => {
  it("mints a valid Change-Id from a handle", async () => {
    const out = await captureStdout(() => changeCommand.run(["new", "auth model"], {}, G));
    const { change_id } = JSON.parse(out);
    expect(change_id).toMatch(/^chg_auth-model-/);
    expect(isValidChangeId(change_id)).toBe(true);
  });

  it("mints a valid Change-Id with no handle", async () => {
    const out = await captureStdout(() => changeCommand.run(["new"], {}, G));
    const { change_id } = JSON.parse(out);
    expect(change_id).toMatch(/^chg_/);
    expect(isValidChangeId(change_id)).toBe(true);
  });

  it("errors on an unknown or missing subcommand", async () => {
    expect(await changeCommand.run(["bogus"], {}, { ...G, json: false })).toBe(1);
    expect(await changeCommand.run([], {}, { ...G, json: false })).toBe(1);
  });
});
