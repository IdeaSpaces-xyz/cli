import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { parseFrontmatter } from "@ideaspaces/protocol";
import { configDir } from "../auth/config-dir.js";

export type AgentRunStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface AgentRunRecord {
  run_id: string;
  parent_id: string | null;
  parent_tool_use_id?: string | null;
  agent: string;
  task?: string | null;
  harness: "pi" | "claude";
  model: string | null;
  model_requested?: string | null;
  model_observed?: string | null;
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

export function agentDisplayName(agentPath: string): string {
  const trimmed = agentPath.replace(/[\\/]+$/, "");
  return win32.basename(trimmed) || agentPath;
}

export function deriveTask(message?: string, cwd: string = process.cwd()): string | null {
  if (!message || typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Split on first line first
  const firstLine = trimmed.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  if (!firstLine) return null;

  // 1. Check if the first line is or begins with a markdown post path
  let candidatePath = firstLine;
  if (firstLine.includes(" — ")) {
    candidatePath = firstLine.split(" — ")[0].trim();
  }
  candidatePath = candidatePath.replace(/^["']|["']$/g, "");

  if (candidatePath.endsWith(".md") || candidatePath.endsWith(".markdown")) {
    const resolvedPath = isAbsolute(candidatePath) ? candidatePath : resolve(cwd, candidatePath);
    try {
      const content = readFileSync(resolvedPath, "utf8");
      const fm = parseFrontmatter(content);
      if (fm && typeof fm.name === "string" && fm.name.trim()) {
        return fm.name.trim();
      }
    } catch {
      // Fall through to text extraction
    }
  }

  // 2. Handle agent-launch patterns: --ask, --consult, --dispatch
  let text = firstLine;
  if (text.includes(" — a question")) {
    text = text.split(" — a question")[0].trim();
  } else if (text.includes(" — a consult")) {
    text = text.split(" — a consult")[0].trim();
  } else if (text.includes(" — a dispatch")) {
    text = text.split(" — a dispatch")[0].trim();
  }

  if (text.includes("Ceiling for this run:")) {
    text = text.split("Ceiling for this run:")[0].trim();
  }

  const sanitized = text.replace(/[\x00-\x1F\x7F]/g, "").trim();
  return (sanitized.length > 300 ? sanitized.slice(0, 300) : sanitized) || null;
}

export function recordAgentRun(record: AgentRunRecord): boolean {
  try {
    const dir = configDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = join(dir, "agent-runs.jsonl");
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, encoding: "utf8" });
    return true;
  } catch {
    return false;
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
    const raw = options.agent.trim().replace(/^[\\/]+|[\\/]+$/g, "").replace(/\\/g, "/");
    if (raw) {
      runs = runs.filter((r) => {
        const norm = r.agent.replace(/^[\\/]+|[\\/]+$/g, "").replace(/\\/g, "/");
        return norm === raw || norm.endsWith(`/${raw}`);
      });
    } else {
      runs = [];
    }
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
      const agentName = agentDisplayName(run.agent);
      const parentPart = run.parent_id ? ` (parent: ${run.parent_id})` : "";
      const convPart = run.conversation_id ? ` · conv: ${run.conversation_id}` : "";
      const taskDisplay = run.task
        ? ` · "${run.task.length > 80 ? `${run.task.slice(0, 77)}...` : run.task}"`
        : "";
      return `${agentName}${taskDisplay} · ${run.harness} · ${run.model || "unreported model"} · ${run.status} — runId: ${run.run_id}${parentPart}${convPart}`;
    })
    .join("\n");
}

export function getAgentRun(runId: string): AgentRunRecord | undefined {
  const runs = listAgentRuns();
  return runs.find((r) => r.run_id === runId);
}

/**
 * Read the cached Claude Code session id for a project directory, matching
 * the plugin's `sessionIdCachePath` location (~/.ideaspaces/sessions/<sha256-prefix>).
 */
export function cachedClaudeSessionId(projectDir: string, home: string = homedir()): string | null {
  try {
    const key = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
    // Prefer configDir parent if ~/.ideaspaces override is in use, fallback to home
    const candidateDirs = [join(configDir(), "..", "sessions"), join(home, ".ideaspaces", "sessions")];
    for (const dir of candidateDirs) {
      const file = join(dir, key);
      if (existsSync(file)) {
        const id = readFileSync(file, "utf8").trim();
        if (id) return id;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Walk upwards from cwd looking for a cached Claude Code session id in an
 * ancestor folder (e.g. agent dir or space root), stopping at repository boundaries.
 */
export function findActiveClaudeSessionId(cwd: string = process.cwd(), home: string = homedir()): string | null {
  let cur = resolve(cwd);
  while (true) {
    const id = cachedClaudeSessionId(cur, home);
    if (id) return id;
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, "_agent"))) {
      // Check enclosing parent once if this was an agent subdirectory
      const parent = dirname(cur);
      if (parent !== cur) {
        const parentId = cachedClaudeSessionId(parent, home);
        if (parentId) return parentId;
      }
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
