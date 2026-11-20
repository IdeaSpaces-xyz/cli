import { defineConfig } from "vitest/config";
import { inMergeQueue, retryFor } from "./scripts/flaky.mjs";
export default defineConfig({
  test: {
    setupFiles: ["./scripts/vitest-git-setup.ts", "./scripts/vitest-quarantine.ts"],
    // Flaky tests (scripts/flaky.mjs): the merge queue retries a failed test once, and names each test
    // that passed only on its retry, so it is set aside the same day in test-quarantine.json. Everywhere
    // else a failure is a failure, and Vitest's own reporters stay as they are.
    retry: retryFor(),
    ...(inMergeQueue() ? { reporters: ["default", "github-actions", "./scripts/vitest-flaky-reporter.ts"] } : {}),
    // On a person's machine, a quarter of the cores, so two runs beside the app stay under How we
    // ship's load limit: each test also starts Git and the CLI, and two full runs at half the cores
    // took a 10-core Mac's load to 23 (2026-11-20). CI passes --maxWorkers=1; a flag on the command
    // line always wins.
    maxWorkers: process.env.CI ? undefined : "25%",
  },
});
