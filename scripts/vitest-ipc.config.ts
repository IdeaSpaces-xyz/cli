import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Opt-in regression probe; never adds 66 seconds to the ordinary suite.
// node scripts/test-git-isolation.mjs --config scripts/vitest-ipc.config.ts --maxWorkers=1
// VITEST_IPC_NEGATIVE_CONTROL=1 omits setup: all assertions pass, but the worker
// must fail its unchanged 60s RPC deadline. Never set this for normal CI.
export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: {
    include: ["scripts/fixtures/worker-ipc.probe.ts"],
    setupFiles: process.env.VITEST_IPC_NEGATIVE_CONTROL === "1"
      ? [] : ["./scripts/vitest-git-setup.ts"],
  },
});
