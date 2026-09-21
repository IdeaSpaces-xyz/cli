/**
 * Which Claude Code tools touch files, and where the path lives in their
 * input — the connector's knowledge, kept beside the harvest that needs it
 * (the SDK's translator hands over Claude's raw names and inputs untouched,
 * as it does for pi). Settled by the recorded run behind the SDK fixture: the
 * native file tools take `file_path` (`NotebookEdit` takes `notebook_path`);
 * MCP tools arrive as `mcp__<server>__<tool>`, so the ideaspaces plugin's
 * `is_write` reaches the harvest through {@link claudeToolBaseName}.
 */

import type { ToolInvocation } from "@ideaspaces/sdk";

export const CLAUDE_FILE_TOOLS: Readonly<Record<string, { kind: "write" | "edit" | "read"; pathArg: string }>> = {
  Write: { kind: "write", pathArg: "file_path" },
  Edit: { kind: "edit", pathArg: "file_path" },
  MultiEdit: { kind: "edit", pathArg: "file_path" },
  NotebookEdit: { kind: "edit", pathArg: "notebook_path" },
  Read: { kind: "read", pathArg: "file_path" },
  LS: { kind: "read", pathArg: "path" },
  Glob: { kind: "read", pathArg: "path" },
  Grep: { kind: "read", pathArg: "path" },
};

/** Strip an MCP server prefix: `mcp__<server>__<tool>` → `<tool>`; native names pass through. */
export function claudeToolBaseName(name: string): string {
  const m = /^mcp__.+?__(.+)$/u.exec(name);
  return m ? m[1] : name;
}

/**
 * Rewrite a Claude tool invocation into the pi-shaped one `harvestLocalFiles`
 * already understands: lower-case `write`/`edit`/`read` with `path`, MCP names
 * stripped to their base. Everything else passes through untouched.
 */
export function normalizeClaudeInvocation(inv: ToolInvocation): ToolInvocation {
  const file = CLAUDE_FILE_TOOLS[inv.name];
  if (file) {
    const path = inv.args[file.pathArg];
    return { ...inv, name: file.kind, args: { ...inv.args, path } };
  }
  const base = claudeToolBaseName(inv.name);
  return base === inv.name ? inv : { ...inv, name: base };
}
