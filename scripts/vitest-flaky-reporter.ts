// Names each test that failed and then passed on its retry (the merge queue retries once), so it is
// set aside the same day. On GitHub: a warning on the test's file and a table in the job summary.
import { appendFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { flakyReport } from "./flaky.mjs";

type Case = { fullName: string; module: { moduleId: string }; diagnostic(): { flaky?: boolean } | undefined };

export default class FlakyReporter {
  private readonly flaky: { file: string; name: string }[] = [];

  onTestCaseResult(testCase: Case) {
    if (testCase.diagnostic()?.flaky) {
      this.flaky.push({ file: relative(process.cwd(), testCase.module.moduleId).split(sep).join("/"), name: testCase.fullName });
    }
  }

  onTestRunEnd() {
    const { lines, summary } = flakyReport(this.flaky, { github: process.env.GITHUB_ACTIONS === "true" });
    for (const line of lines) console.log(line);
    if (summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
