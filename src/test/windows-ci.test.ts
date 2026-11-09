import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const windows = ci.jobs.windows;
const gate = ci.jobs["windows-gate"];

describe("required Windows CI stays fail-closed across native shards", () => {
  it("runs both serial native shards without increasing the 15-minute allowance", () => {
    expect(windows["runs-on"]).toBe("windows-latest");
    expect(windows["timeout-minutes"]).toBe(15);
    expect(windows.strategy["fail-fast"]).toBe(false);
    expect(windows.strategy.matrix.shard).toEqual([1, 2]);
    const test = windows.steps.find((step: { name?: string }) => step.name === "Test").run;
    expect(test).toBe("npm test -- --maxWorkers=1 --no-file-parallelism --shard=${{ matrix.shard }}/2");
    expect(windows.steps.some((step: { run?: string }) => step.run === "npx tsc --noEmit")).toBe(true);
    expect(windows.steps.some((step: { run?: string }) => step.run === "npm run check:package")).toBe(true);
  });

  it("keeps the required status name, waiting for all shards even after a failure", () => {
    expect(gate.name).toBe("Typecheck, test, bundle (windows-latest)");
    expect(gate.needs).toEqual(["windows"]);
    expect(gate.if).toBe("${{ always() }}");
    expect(gate.steps[0].env.WINDOWS_RESULT).toBe("${{ needs.windows.result }}");
    // Avoid two jobs producing the same required Windows status name.
    expect(ci.jobs.build.strategy.matrix.os).not.toContain("windows-latest");
    for (const event of ["pull_request", "merge_group", "push", "workflow_dispatch"]) {
      expect(Object.hasOwn(ci.on, event)).toBe(true);
    }
  });

  it.each(["success", "failure", "cancelled", "skipped", ""])("actual gate command admits only success, not %j", (result) => {
    const command = /^node -e "([^"]+)"$/.exec(gate.steps[0].run);
    expect(command).not.toBeNull();
    const child = spawnSync(process.execPath, ["-e", command![1]], {
      env: { ...process.env, WINDOWS_RESULT: result }, encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(result === "success" ? 0 : 1);
  });
});
