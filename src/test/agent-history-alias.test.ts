import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAgentRuns, recordAgentRun, type AgentRunRecord } from "../local/agent-runs.js";

const paths: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });
it("finds history through either physical or alias spelling without rewriting records", () => {
  const home = mkdtempSync(join(tmpdir(), "history-alias-")); paths.push(home); vi.stubEnv("HOME", home);
  const actual = join(home, "actual"); mkdirSync(actual);
  const alias = join(home, "alias"); symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const base: AgentRunRecord = { run_id: "real", parent_id: null, agent: realpathSync.native(actual), harness: "pi", model: null, conversation_id: null, status: "completed", started_at: "2026-01-01", ended_at: null };
  expect(recordAgentRun(base)).toBe(true);
  expect(recordAgentRun({ ...base, run_id: "old-alias", agent: alias })).toBe(true);
  for (const filter of [alias, actual]) expect(listAgentRuns({ agent: filter }).map(r => r.run_id).sort()).toEqual(["old-alias", "real"]);
  const other = join(home, "other"); mkdirSync(other);
  expect(listAgentRuns({ agent: other })).toEqual([]);
  rmSync(alias, { recursive: true }); rmSync(actual, { recursive: true });
  expect(listAgentRuns({ agent: actual }).map(r => r.run_id)).toEqual(["real"]);
  expect(listAgentRuns({ agent: "alias" }).map(r => r.run_id)).toEqual(["old-alias"]);
});
