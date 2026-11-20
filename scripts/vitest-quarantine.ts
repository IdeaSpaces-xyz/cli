// Tests set aside in test-quarantine.json are skipped, each with its owner and issue in the reason,
// so a skipped test says who is fixing it (scripts/flaky.mjs).
import { beforeEach } from "vitest";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { quarantined, readQuarantine, testName } from "./flaky.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tests } = readQuarantine(repo);

beforeEach((context) => {
  if (!tests.length) return;
  const file = relative(repo, context.task.file.filepath).split(sep).join("/");
  const entry = quarantined(tests, file, testName(context.task));
  if (entry) context.skip(`set aside since ${entry.since}: ${entry.owner}, ${entry.issue}`);
});
