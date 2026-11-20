import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./scripts/vitest-git-setup.ts"],
    // On a person's machine, half the cores, so two runs (or a run beside the app) fit side by side.
    // CI passes --maxWorkers=1; a flag on the command line always wins.
    maxWorkers: process.env.CI ? undefined : "50%",
  },
});
