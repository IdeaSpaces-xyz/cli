import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../auth/config-dir.js";

export type AgentRunStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface AgentRunRecord {
  run_id: string;
  parent_id: string | null;
  parent_tool_use_id?: string | null;
  agent: string;
  harness: "pi" | "claude";
  model: string | null;
  conversation_id: string | null;
  status: AgentRunStatus;
  started_at: string;
  ended_at: string | null;
}

export interface ListAgentRunsOptions {
  parentId?: string;
  agent?: string;
  limit?: number;
}

export function recordAgentRun(record: AgentRunRecord): void {
  try {
    const dir = configDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = join(dir, "agent-runs.jsonl");
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, encoding: "utf8" });
  } catch {
    // Bookkeeping must never crash the run
  }
}

export function listAgentRuns(options: ListAgentRunsOptions = {}): AgentRunRecord[] {
  const file = join(configDir(), "agent-runs.jsonl");
  if (!existsSync(file)) return [];

  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const byRunId = new Map<string, AgentRunRecord>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as AgentRunRecord;
      if (item && typeof item === "object" && typeof item.run_id === "string") {
        const existing = byRunId.get(item.run_id);
        byRunId.set(item.run_id, existing ? { ...existing, ...item } : item);
      }
    } catch {
      // ignore malformed line
    }
  }

  let runs = [...byRunId.values()];

  if (options.parentId !== undefined) {
    runs = runs.filter((r) => r.parent_id === options.parentId);
  }
  if (options.agent !== undefined && options.agent.trim()) {
    const match = options.agent.trim();
    runs = runs.filter((r) => r.agent === match || r.agent.endsWith(`/${match}`));
  }

  // Sort newest first by started_at descending
  runs.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));

  if (typeof options.limit === "number" && options.limit > 0) {
    runs = runs.slice(0, options.limit);
  }

  return runs;
}

export function formatAgentRunsText(runs: AgentRunRecord[], parentFilter?: string): string {
  if (runs.length === 0) {
    return parentFilter
      ? `No agent runs recorded for parent ${parentFilter}.`
      : "No agent runs recorded.";
  }

  return runs
    .map((run) => {
      const agentName = run.agent.split("/").pop() || run.agent;
      const parentPart = run.parent_id ? ` (parent: ${run.parent_id})` : "";
      const convPart = run.conversation_id ? ` · conv: ${run.conversation_id}` : "";
      return `${agentName} · ${run.harness} · ${run.model || "unreported model"} · ${run.status} — runId: ${run.run_id}${parentPart}${convPart}`;
    })
    .join("\n");
}
