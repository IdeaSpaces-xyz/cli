import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["./scripts/vitest-git-setup.ts"] } });
