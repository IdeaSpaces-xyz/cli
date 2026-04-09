import { describe, it, expect } from "vitest";
import { createOutput } from "../output.js";
import { handleError } from "../errors.js";
import { SdkError } from "@ideaspaces/sdk";
import type { GlobalFlags } from "../types.js";

const baseFlags: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

describe("output", () => {
  it("result writes human text to stdout by default", () => {
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stdout.write;
    const output = createOutput(baseFlags);
    output.result({ foo: 1 }, "hello");
    process.stdout.write = origWrite;
    expect(captured).toBe("hello\n");
  });

  it("result writes JSON to stdout with --json", () => {
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stdout.write;
    const output = createOutput({ ...baseFlags, json: true });
    output.result({ foo: 1 }, "hello");
    process.stdout.write = origWrite;
    expect(JSON.parse(captured)).toEqual({ foo: 1 });
  });

  it("log writes to stderr", () => {
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stderr.write;
    const output = createOutput(baseFlags);
    output.log("info");
    process.stderr.write = origWrite;
    expect(captured).toBe("info\n");
  });

  it("log is suppressed by --quiet", () => {
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stderr.write;
    const output = createOutput({ ...baseFlags, quiet: true });
    output.log("info");
    process.stderr.write = origWrite;
    expect(captured).toBe("");
  });

  it("error always writes to stderr", () => {
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stderr.write;
    const output = createOutput({ ...baseFlags, quiet: true });
    output.error("bad");
    process.stderr.write = origWrite;
    expect(captured).toBe("bad\n");
  });
});

describe("errors", () => {
  function captureError(err: unknown): { code: number; text: string } {
    let text = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { text += chunk; return true; }) as typeof process.stderr.write;
    const output = createOutput(baseFlags);
    const code = handleError(err, output);
    process.stderr.write = origWrite;
    return { code, text };
  }

  it("maps auth_error to exit 3", () => {
    const { code, text } = captureError(new SdkError({ category: "auth_error", message: "Invalid token", status: 401, retryable: false }));
    expect(code).toBe(3);
    expect(text).toContain("ideaspaces login");
  });

  it("maps not_found to exit 4", () => {
    const { code, text } = captureError(new SdkError({ category: "not_found", message: "File not found", status: 404, retryable: false }));
    expect(code).toBe(4);
    expect(text).toContain("ideaspaces navigate");
  });

  it("maps rate_limited to exit 6", () => {
    const { code } = captureError(new SdkError({ category: "rate_limited", message: "Too fast", status: 429, retryable: true }));
    expect(code).toBe(6);
  });

  it("handles not-logged-in error", () => {
    const { code, text } = captureError(new Error("Not logged in. Run: ideaspaces login"));
    expect(code).toBe(2);
    expect(text).toContain("ideaspaces login");
  });

  it("handles generic errors", () => {
    const { code } = captureError(new Error("Something broke"));
    expect(code).toBe(1);
  });

  it("handles non-Error values", () => {
    const { code, text } = captureError("string error");
    expect(code).toBe(1);
    expect(text).toContain("string error");
  });
});
