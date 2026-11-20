// The flaky-test rule (scripts/flaky.mjs): a retry only in the merge queue, a short and well-formed
// list of tests set aside, and a run that names a test that passed only on its retry.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flakyReport, MAX_QUARANTINED, problems, quarantined, readQuarantine, retryFor, testName } from "../../scripts/flaky.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ISSUES = "https://github.com/IdeaSpaces-xyz/cli/issues/";

describe("the retry", () => {
  it("is once, and only in the merge queue", () => {
    expect(retryFor({ GITHUB_EVENT_NAME: "merge_group" })).toBe(1);
    for (const event of ["pull_request", "push", "workflow_dispatch", undefined]) expect(retryFor({ GITHUB_EVENT_NAME: event })).toBe(0);
  });
});

describe("test-quarantine.json", () => {
  it("is short and well formed, and each entry names a real test, an owner and an issue", () => {
    expect(problems(readQuarantine(repo), repo, ISSUES)).toEqual([]);
  });

  it("refuses an entry without an owner or issue, a wrong issue, a missing test, a duplicate, and a long list", () => {
    const root = mkdtempSync(join(tmpdir(), "quarantine-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.test.ts"), `describe("group", () => { it("is real", () => {}); });`);
      const good = { file: "src/a.test.ts", name: "group > is real", owner: "Integrator", issue: `${ISSUES}1`, since: "2026-11-20" };
      expect(problems({ tests: [good] }, root, ISSUES)).toEqual([]);
      expect(problems({ tests: [{ ...good, owner: "" }] }, root, ISSUES)).toEqual(["test 1 (group > is real): no owner"]);
      expect(problems({ tests: [{ ...good, issue: undefined }] }, root, ISSUES)).toEqual(["test 1 (group > is real): no issue"]);
      expect(problems({ tests: [{ ...good, issue: "https://github.com/other/repo/issues/1" }] }, root, ISSUES)[0]).toMatch(/issue must be/);
      expect(problems({ tests: [{ ...good, since: "yesterday" }] }, root, ISSUES)[0]).toMatch(/since must be/);
      expect(problems({ tests: [{ ...good, platform: "windows" }] }, root, ISSUES)[0]).toMatch(/platform must be/);
      expect(problems({ tests: [{ ...good, name: "group > is gone" }] }, root, ISSUES)[0]).toMatch(/has no test named "is gone"/);
      expect(problems({ tests: [{ ...good, file: "src/b.test.ts" }] }, root, ISSUES)[0]).toMatch(/does not exist/);
      expect(problems({ tests: [good, good] }, root, ISSUES)).toEqual(["test 2 (group > is real): listed twice"]);
      expect(problems({ tests: Array.from({ length: MAX_QUARANTINED + 1 }, (_, i) => ({ ...good, platform: i % 2 ? "linux" : "darwin", name: good.name })) }, root, ISSUES)[0]).toMatch(/at most 5/);
      expect(problems({}, root, ISSUES)).toEqual(["test-quarantine.json has no `tests` list"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("sets a test aside by file, name and platform", () => {
    const entry = { file: "src/a.test.ts", name: "group > is real", owner: "Integrator", issue: `${ISSUES}1`, since: "2026-11-20", platform: "win32" };
    expect(quarantined([entry], "src/a.test.ts", "group > is real", "win32")).toBe(entry);
    expect(quarantined([entry], "src/a.test.ts", "group > is real", "darwin")).toBeUndefined();
    expect(quarantined([{ ...entry, platform: undefined }], "src/a.test.ts", "group > is real", "darwin")).toBeTruthy();
    expect(quarantined([entry], "src/a.test.ts", "group > other", "win32")).toBeUndefined();
  });

  it("names a test as the FAIL line does after the file", () => {
    const file = { name: "a.test.ts", filepath: "/r/src/a.test.ts" };
    const outer = { name: "outer", suite: file };
    const inner = { name: "inner", suite: outer };
    expect(testName({ name: "it works", suite: inner, file })).toBe("outer > inner > it works");
    expect(testName({ name: "top level", suite: file, file })).toBe("top level");
  });

  it("names this very test the way the setup file will look it up", ({ task }) => {
    expect(testName(task)).toBe("test-quarantine.json > names this very test the way the setup file will look it up");
  });
});

describe("a test that passed only on its retry", () => {
  const flaky = [{ file: "src/a.test.ts", name: "group > is real" }];
  it("is a warning on its file in GitHub, and a row in the job summary", () => {
    const { lines, summary } = flakyReport(flaky, { github: true });
    expect(lines).toEqual(["::warning file=src/a.test.ts,title=Flaky test::group > is real failed, then passed on its retry. Set it aside today in test-quarantine.json, with an owner and an issue."]);
    expect(summary).toContain("| `src/a.test.ts` | group > is real |");
  });
  it("is one plain line elsewhere, and nothing at all when no test needed its retry", () => {
    expect(flakyReport(flaky).lines).toEqual(["Flaky: src/a.test.ts > group > is real failed, then passed on its retry. Set it aside today in test-quarantine.json, with an owner and an issue."]);
    expect(flakyReport([])).toEqual({ lines: [], summary: "" });
  });
});
