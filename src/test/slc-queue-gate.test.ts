import { describe, expect, it } from "vitest";
// The gate is plain ESM so the queue workflow can run it with `node` and no build.
import { decide, queueEntry, recommendation, reviewWindow } from "../../.github/scripts/slc-queue-gate.mjs";

const head = "a".repeat(40);
const group = "b".repeat(40);
const base = "c".repeat(40);
const ref = `refs/heads/gh-readonly-queue/main/pr-298-${group}`;
const pr = { number: 298, base: { ref: "main" }, head: { sha: head } };
const run = { name: "slc-review", app: { slug: "github-actions" }, status: "completed", conclusion: "success", started_at: "2026-11-07T09:24:44Z", completed_at: "2026-11-07T09:25:49Z", html_url: "https://example.test/run" };
const verdict = (body: string, extra = {}) => ({
  user: { login: "claude[bot]", type: "Bot" }, created_at: "2026-11-07T09:25:42Z", updated_at: "2026-11-07T09:25:42Z",
  html_url: "https://example.test/comment", body, ...extra,
});
const approve = verdict("**SLC Assessment:** fine.\n\n**Recommendation:** Approve");
const input = (over: Record<string, unknown> = {}) => ({ ref, groupParents: [base, head], pr, checkRuns: [run], pages: [[approve]], ...over });

describe("SLC queue gate", () => {
  it("lands an Approve posted inside the head's review run", () => {
    expect(decide(input()).land).toBe(true);
  });

  it("refuses a Request Changes, a Comment and a missing recommendation", () => {
    for (const body of ["**Recommendation:** Request Changes. Items 1–3 block.", "Recommendation: Comment", "Looks good to me."]) {
      const result = decide(input({ pages: [[verdict(body)]] }));
      expect(result.land, body).toBe(false);
      expect(result.reason).toContain("is not Approve");
    }
  });

  it("refuses a template left unfilled and a second recommendation line", () => {
    expect(decide(input({ pages: [[verdict("Recommendation: Approve / Request Changes / Comment")]] })).land).toBe(false);
    expect(decide(input({ pages: [[verdict("Recommendation: Approve\nRecommendation: Request Changes")]] })).land).toBe(false);
  });

  it("reads the label with markdown around it and a reason after it", () => {
    expect(recommendation("**Recommendation:** Approve.")).toBe("Approve");
    expect(recommendation("**Recommendation:** Approve. The points above are non-blocking polish.")).toBe("Approve");
    expect(recommendation("**Recommendation:** Request Changes. Items 1 to 3.")).toBe("Request Changes");
    expect(recommendation("Recommendation: **Approve**")).toBe("Approve");
    expect(recommendation("**Recommendation:** Request Changes. Items 1 to 3.")).toBe("Request Changes");
  });

  it("does not read a clause after Approve as an Approve", () => {
    for (const text of ["Approve, but fix item 2 first", "Approve with changes", "Approved once CI is green", "Approve - but fix item 2 first", "Approve — don't merge until X", "Approve: after fixing X", "Approve; but later", "Approve (once CI is green)", "Approve (posted as a comment)"]) {
      expect(recommendation(`Recommendation: ${text}`), text).toBe("ambiguous");
    }
  });

  it("refuses when nothing was posted in the window, or the comment is from a person", () => {
    expect(decide(input({ pages: [[]] })).land).toBe(false);
    expect(decide(input({ pages: [[verdict("Recommendation: Approve", { user: { login: "ernests", type: "User" } })]] })).land).toBe(false);
    expect(decide(input({ pages: [[verdict("Recommendation: Approve", { user: { login: "claude[bot]", type: "User" } })]] })).land).toBe(false);
  });

  it("refuses an Approve posted before or after the head's review run", () => {
    for (const created_at of ["2026-11-07T09:24:43Z", "2026-11-07T09:25:50Z"]) {
      const result = decide(input({ pages: [[verdict("Recommendation: Approve", { created_at, updated_at: created_at })]] }));
      expect(result.land, created_at).toBe(false);
      expect(result.reason).toContain("found 0");
    }
  });

  it("refuses two comments in the window, so an older Approve cannot stand in for the head", () => {
    const older = verdict("Recommendation: Approve", { created_at: "2026-11-07T09:25:00Z", updated_at: "2026-11-07T09:25:00Z" });
    const result = decide(input({ pages: [[older], [verdict("Recommendation: Request Changes")]] }));
    expect(result.land).toBe(false);
    expect(result.reason).toContain("found 2");
  });

  it("refuses a verdict edited after posting", () => {
    const edited = verdict("Recommendation: Approve", { updated_at: "2026-11-07T09:30:00Z" });
    expect(decide(input({ pages: [[edited]] })).reason).toContain("edited after posting");
  });

  it("refuses a head whose review did not succeed, or only skipped as a draft", () => {
    expect(decide(input({ checkRuns: [] })).land).toBe(false);
    expect(decide(input({ checkRuns: [{ ...run, conclusion: "skipped" }] })).land).toBe(false);
    expect(decide(input({ checkRuns: [{ ...run, conclusion: "failure" }] })).land).toBe(false);
    expect(decide(input({ checkRuns: [{ ...run, app: { slug: "someone-else" } }] })).land).toBe(false);
    expect(decide(input({ checkRuns: [{ ...run, name: "other" }] })).land).toBe(false);
  });

  it("uses the newest successful run when the review was rerun", () => {
    const rerun = { ...run, started_at: "2026-11-07T10:00:00Z", completed_at: "2026-11-07T10:01:00Z" };
    expect(reviewWindow([run, rerun])?.from).toBe(Date.parse("2026-11-07T10:00:00Z"));
    expect(decide(input({ checkRuns: [run, rerun] })).land).toBe(false);
  });

  it("refuses a group that does not merge the PR's head", () => {
    expect(decide(input({ groupParents: [base, "d".repeat(40)] })).land).toBe(false);
    expect(decide(input({ groupParents: [head] })).land).toBe(false);
    expect(decide(input({ groupParents: [base, head, base] })).land).toBe(false);
  });

  it("refuses PR data that does not match the queue entry, or a ref that is not one", () => {
    expect(decide(input({ pr: { ...pr, number: 7 } })).land).toBe(false);
    expect(decide(input({ pr: { ...pr, base: { ref: "dev" } } })).land).toBe(false);
    expect(decide(input({ pr: { ...pr, head: { sha: "short" } } })).land).toBe(false);
    expect(decide(input({ ref: "refs/heads/main" })).land).toBe(false);
    expect(queueEntry(ref)).toEqual({ base: "main", number: 298 });
  });
});
