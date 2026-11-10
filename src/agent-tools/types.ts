/** Catalogs describe contracts, never exposure, permissions or authority. */
export interface Parameter {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Parameter>;
  items?: Parameter;
  required?: string[];
  additionalProperties?: boolean;
  enum?: (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}
export interface Entry {
  id: string;
  owner: "cli" | "host";
  implemented_by?: string[];
  status: "active" | "retired";
  refusal?: string;
  job: string;
  effect: "read" | "write-local" | "write-hosted" | "share" | "launch" | "account" | "status";
  reach: "local" | "hosted" | "local+hosted";
  confirm: "none" | "plan-then-yes" | "person-presses-send" | "person-presses-start" | "browser";
  requires: { cli: string; features?: string[] };
  text: { does: string; use_when: string; check: string; bound: string };
  bound: "unbounded" | "n/a" | { unit: "entries" | "posts" | "bytes" | "lines"; default?: number; max?: number; says: boolean; continue?: "since" | "cursor" };
  parameters: Parameter & { type: "object" };
  cli?: {
    argv: string[];
    positional: string[];
    flags: Record<string, { flag: string; aliases?: string[]; list?: "csv" | "repeat"; boolean?: "bare" }>;
    /** Routing-specific subsets, not a host allowlist. */
    local_flags?: string[];
    hosted_flags?: string[];
    alias_flags?: Record<string, string[]>;
  };
  calls?: string[];
  output?: { json: string[] };
  aliases?: string[];
}
export interface Group { id: string; job: string; name: string; use_when: string }
export interface BuildIdentity { version: string; commit: string }
export interface Catalog {
  schema: "ideaspaces.agent-tools";
  version: 1;
  cli: BuildIdentity;
  protocol: BuildIdentity;
  digest: string;
  groups: Group[];
  entries: Entry[];
  exclusions: { id: string; reason: string }[];
  capabilities: { threads: unknown; agent: unknown };
}
