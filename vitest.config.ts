import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./scripts/vitest-git-setup.ts"],
    // On a person's machine, a quarter of the cores, so two runs beside the app stay under How we
    // ship's load limit: each test also starts Git and the CLI, and two full runs at half the cores
    // took a 10-core Mac's load to 23 (2026-11-20). CI passes --maxWorkers=1; a flag on the command
    // line always wins.
    maxWorkers: process.env.CI ? undefined : "25%",
  },
});
