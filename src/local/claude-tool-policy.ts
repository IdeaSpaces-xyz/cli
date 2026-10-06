// Claude's --allowedTools preapproves; it does not restrict available tools.
// A read-only agent must also use --tools Read,Grep,Glob and --strict-mcp-config.
export const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob"] as const;

// A writable hand-over's preapprovals. This is not a shell security boundary;
// the person's accepted contract is the Space reach and the owner's Agreement.
export const CLAUDE_HANDOVER_TOOLS = [
  "Read", "Grep", "Glob", "mcp__plugin_ideaspaces_core__*",
  "Edit", "Write", "Bash(git:*)", "Bash(ideaspaces:*)",
] as const;
