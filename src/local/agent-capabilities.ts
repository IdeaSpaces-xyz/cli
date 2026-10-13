/**
 * What `agent run` guarantees to a launcher, as data. Consumers (fellow-session
 * adapters, desktop) check these feature names instead of reading `--help`
 * prose, which is written for people and may be reworded in any release.
 *
 * A feature name is a promise: once listed it keeps its meaning, and removing
 * one is a breaking change. Add a new name for new behaviour.
 */

export const AGENT_RUN_CAPABILITIES_SCHEMA = "ideaspaces.agent-run.capabilities";
export const AGENT_RUN_CAPABILITIES_VERSION = 1;

export const AGENT_RUN_FEATURES = {
  /** Pi child loads only the `--ext` paths given; `--no-extensions` stops discovery. */
  "pi.explicit-extensions": "Pi loads only the --ext paths given; installed and project extensions are not discovered.",
  "pi.retry-terminal": "Pi intermediate agent_end with willRetry waits for its built-in bounded retry; a started run ends in a final result or error.",
  /** Pi child loads only the `--skill` dirs given; `--no-skills` stops discovery. */
  "pi.skill-isolation": "Pi loads only the --skill dirs given; user and project skills are not discovered.",
  "pi.trust": "--pi-trust saved|explicit selects Pi project-resource trust.",
  "pi.thinking": "--pi-thinking passes a Pi thinking level.",
  "claude.read-only": "--read-only exposes only Read, Grep and Glob and drops MCP servers.",
  "claude.effort": "--claude-effort passes a Claude Code effort level.",
  "claude.permission-mode": "--permission-mode selects a Claude Code permission mode (bypass refused).",
  /** `message_start` carries `model_requested` and `model_observed`, each a string or null. */
  "model.requested-observed": "message_start reports model_requested and model_observed separately; null means none requested or none reported.",
  /** `agent run` writes run records queryable via `agent runs`. */
  "run.records": "agent run writes run records (parent, agent, harness, model, conversation) read by agent runs.",
  /** `agent record` writes or updates run records for external sessions and hooks. */
  "run.record-command": "agent record appends or updates run records from external sessions and hooks.",
  "run.terminal-error": "A started agent run --json emits an error if the local runtime returns without a terminal event; preflight errors remain on stderr and cancelled remains a distinct terminal event.",
  "run.cancelled-nonzero": "A cancelled agent run preserves its cancelled event and run-record status, but exits nonzero so launchers do not count it as success.",
} as const;

export type AgentRunFeature = keyof typeof AGENT_RUN_FEATURES;

export interface AgentRunCapabilities {
  schema: typeof AGENT_RUN_CAPABILITIES_SCHEMA;
  version: typeof AGENT_RUN_CAPABILITIES_VERSION;
  features: AgentRunFeature[];
}

export function agentRunCapabilities(): AgentRunCapabilities {
  return {
    schema: AGENT_RUN_CAPABILITIES_SCHEMA,
    version: AGENT_RUN_CAPABILITIES_VERSION,
    features: Object.keys(AGENT_RUN_FEATURES) as AgentRunFeature[],
  };
}

export function formatAgentRunCapabilities(caps: AgentRunCapabilities): string {
  return [
    `${caps.schema} v${caps.version}`,
    ...caps.features.map((name) => `  ${name} — ${AGENT_RUN_FEATURES[name]}`),
  ].join("\n");
}
