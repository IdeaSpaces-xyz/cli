// Claude Code plugin tool names at the launcher boundary. --allowedTools preapproves;
// it does not restrict availability, so read-only also limits builtins with --tools
// and explicitly denies plugin effects with --disallowedTools.
export const CLAUDE_READ_TOOLS = [
  "Read", "Grep", "Glob",
  "mcp__plugin_ideaspaces_core__is_look",
  "mcp__plugin_ideaspaces_core__is_navigate",
  "mcp__plugin_ideaspaces_core__is_status",
  "mcp__plugin_ideaspaces_core__is_get",
  "mcp__plugin_ideaspaces_core__is_spaces",
] as const;

export const CLAUDE_HANDOVER_TOOLS = [
  "Read", "Grep", "Glob", "mcp__plugin_ideaspaces_core__*",
  "Edit", "Write", "Bash(git:*)", "Bash(ideaspaces:*)",
] as const;

export const CLAUDE_DENIED_EFFECTS = [
  "is_auth", "is_threads", "is_follow", "is_write", "is_commit",
  "is_change_open", "is_change_close", "is_pull", "is_push", "is_clone", "is_collaborate",
].map((name) => `mcp__plugin_ideaspaces_core__${name}`);
