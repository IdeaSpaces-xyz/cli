// Flaky tests (How we ship, 2026-11-20, msg_df0c49b1): the merge queue retries a failed test once;
// a test that failed and then passed is named in the run, and set aside the same day in
// test-quarantine.json with an owner and an issue. This module is the logic; vitest.config.ts,
// scripts/vitest-quarantine.ts and scripts/vitest-flaky-reporter.ts use it, and
// src/test/test-quarantine.test.ts checks it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The merge queue runs with GITHUB_EVENT_NAME=merge_group. Only there is a failure retried. */
export const inMergeQueue = (env = process.env) => env.GITHUB_EVENT_NAME === "merge_group";
export const retryFor = (env = process.env) => (inMergeQueue(env) ? 1 : 0);

/** A short list, so that setting a test aside stays a decision and never a habit. */
export const MAX_QUARANTINED = 5;
export const PLATFORMS = ["darwin", "linux", "win32"];

export function readQuarantine(repo) {
  return JSON.parse(readFileSync(join(repo, "test-quarantine.json"), "utf8"));
}

/** A test's name as Vitest's FAIL line shows it after the file: "describe > it". */
export function testName(task) {
  const names = [];
  for (let current = task; current; current = current.suite) {
    if (current === task.file || "filepath" in current) break;
    if (current.name) names.unshift(current.name);
  }
  return names.join(" > ");
}

/** The entry that sets this test aside on this platform, if any. */
export function quarantined(tests, file, name, platform = process.platform) {
  return tests.find((entry) => entry.file === file && entry.name === name && (!entry.platform || entry.platform === platform));
}

/** What is wrong with the list, in words; empty when it is well formed. */
export function problems(list, repo, issuePrefix) {
  const found = [];
  if (!list || !Array.isArray(list.tests)) return ["test-quarantine.json has no `tests` list"];
  if (list.tests.length > MAX_QUARANTINED) found.push(`${list.tests.length} tests are set aside; at most ${MAX_QUARANTINED}. Fix one before adding another.`);
  const seen = new Set();
  list.tests.forEach((entry, index) => {
    const at = `test ${index + 1} (${entry?.name ?? "no name"})`;
    for (const key of ["file", "name", "owner", "issue", "since"]) {
      if (typeof entry?.[key] !== "string" || !entry[key].trim()) found.push(`${at}: no ${key}`);
    }
    if (typeof entry?.issue === "string" && !new RegExp(`^${issuePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`).test(entry.issue)) {
      found.push(`${at}: issue must be ${issuePrefix}<number>`);
    }
    if (typeof entry?.since === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(entry.since)) found.push(`${at}: since must be YYYY-MM-DD`);
    if (entry?.platform !== undefined && !PLATFORMS.includes(entry.platform)) found.push(`${at}: platform must be one of ${PLATFORMS.join(", ")}`);
    if (typeof entry?.file === "string" && typeof entry?.name === "string") {
      const key = `${entry.file} > ${entry.name} > ${entry.platform ?? "all"}`;
      if (seen.has(key)) found.push(`${at}: listed twice`);
      seen.add(key);
      const path = join(repo, entry.file);
      if (!existsSync(path)) found.push(`${at}: ${entry.file} does not exist`);
      else {
        const last = entry.name.split(" > ").at(-1);
        if (!readFileSync(path, "utf8").includes(last)) found.push(`${at}: ${entry.file} has no test named "${last}"`);
      }
    }
  });
  return found;
}

/** The lines a run prints for tests that passed only on their retry. */
export function flakyReport(flaky, { github = false } = {}) {
  if (!flaky.length) return { lines: [], summary: "" };
  const advice = "Set it aside today in test-quarantine.json, with an owner and an issue.";
  const lines = flaky.map(({ file, name }) => github
    ? `::warning file=${file},title=Flaky test::${name} failed, then passed on its retry. ${advice}`
    : `Flaky: ${file} > ${name} failed, then passed on its retry. ${advice}`);
  const summary = [
    "### Flaky tests",
    "These failed, then passed on their one retry. Set each aside today in `test-quarantine.json`, with an owner and an issue.",
    "",
    "| File | Test |",
    "|---|---|",
    ...flaky.map(({ file, name }) => `| \`${file}\` | ${name.replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n");
  return { lines, summary };
}
