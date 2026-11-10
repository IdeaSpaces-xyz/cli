import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { sourceCommit } from "../../scripts/source-commit.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function recorded(cli: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "is-source-commit-")); dirs.push(dir);
  const path = join(dir, "agent-tools.json");
  writeFileSync(path, JSON.stringify({ cli }));
  return path;
}
const git = (answers: Record<string, string | Error>) => (args: string[]) => {
  const answer = answers[args[0] === "log" ? "log" : "shallow"];
  if (answer instanceof Error) throw answer;
  return answer;
};

describe("catalog source commit", () => {
  it("reads the last source commit from a full checkout", () => {
    expect(sourceCommit(["src"], { version: "1.0.0", run: git({ shallow: "false", log: A }), recordedPath: recorded({ version: "1.0.0", commit: B }) })).toBe(A);
  });
  it("keeps the committed record in a copy with no .git, as npm builds a github: dependency", () => {
    expect(sourceCommit(["src"], { version: "1.0.0", run: git({ shallow: new Error("not a git repository"), log: new Error("x") }), recordedPath: recorded({ version: "1.0.0", commit: B }) })).toBe(B);
  });
  it("keeps the committed record in a shallow clone instead of reading the newest commit", () => {
    expect(sourceCommit(["src"], { version: "1.0.0", run: git({ shallow: "true", log: A }), recordedPath: recorded({ version: "1.0.0", commit: B }) })).toBe(B);
  });
  it("refuses, naming the fix, when there is neither history nor a record for this version", () => {
    const run = git({ shallow: new Error("not a git repository"), log: new Error("x") });
    expect(() => sourceCommit(["src"], { version: "2.0.0", run, recordedPath: recorded({ version: "1.0.0", commit: B }) })).toThrow(/full Git checkout.*version 2\.0\.0/);
    expect(() => sourceCommit(["src"], { version: "1.0.0", run, recordedPath: "/nonexistent/agent-tools.json" })).toThrow(/full Git checkout/);
  });
});
