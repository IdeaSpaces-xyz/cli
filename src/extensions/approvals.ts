/**
 * Approval records — the one thing that lets an agent-declared extension load.
 * An agent repo syncs; a pull can add `git:host/repo@ref` to its `.pi/settings.json`
 * and that is code that would run with the agent's full access. So nothing
 * declared loads until a person approved exactly that source, for exactly that
 * agent root; a changed ref is a new source and asks again. Same shape as the
 * runtimes' own project trust, kept here because Desktop turns run headless and
 * cannot answer a runtime's dialog.
 *
 * Stored in `~/.ideaspaces/extension-approvals.json` beside the credentials.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../auth/config-dir.js";
import type { ExtensionRuntime } from "./model.js";

export interface ExtensionApproval {
  runtime: ExtensionRuntime;
  /** The agent repo the declaration lives in, absolute. */
  agentRoot: string;
  /** The declared source verbatim (ref included) — pi source or plugin id. */
  source: string;
  approvedAt: string;
}

interface ApprovalFile {
  approvals?: unknown;
}

export function approvalsPath(): string {
  return join(configDir(), "extension-approvals.json");
}

export function readApprovals(file = approvalsPath()): ExtensionApproval[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A corrupt approvals file approves nothing — the safe direction.
    return [];
  }
  const list = (parsed as ApprovalFile | null)?.approvals;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (a): a is ExtensionApproval =>
      !!a && typeof a === "object" &&
      typeof (a as ExtensionApproval).runtime === "string" &&
      typeof (a as ExtensionApproval).agentRoot === "string" &&
      typeof (a as ExtensionApproval).source === "string",
  );
}

export function writeApprovals(approvals: ExtensionApproval[], file = approvalsPath()): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ approvals }, null, 2)}\n`, { mode: 0o600 });
}

export function isApproved(
  approvals: ExtensionApproval[],
  runtime: ExtensionRuntime,
  agentRoot: string,
  source: string,
): boolean {
  return approvals.some((a) => a.runtime === runtime && a.agentRoot === agentRoot && a.source === source);
}

/** Add an approval; idempotent on the (runtime, agentRoot, source) key. */
export function approve(
  approvals: ExtensionApproval[],
  entry: Omit<ExtensionApproval, "approvedAt">,
  now = new Date(),
): ExtensionApproval[] {
  if (isApproved(approvals, entry.runtime, entry.agentRoot, entry.source)) return approvals;
  return [...approvals, { ...entry, approvedAt: now.toISOString() }];
}

export function revoke(
  approvals: ExtensionApproval[],
  entry: Omit<ExtensionApproval, "approvedAt">,
): ExtensionApproval[] {
  return approvals.filter(
    (a) => !(a.runtime === entry.runtime && a.agentRoot === entry.agentRoot && a.source === entry.source),
  );
}
