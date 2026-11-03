import type { ContentRepresentation, ContractSource } from "@ideaspaces/protocol";

/** CLI habitat policy above the protocol's deliberately neutral source selection. */
export function preferredContractSource(
  available: readonly ContractSource[],
): ContractSource | null {
  if (available.includes("agreement")) return "agreement";
  if (available.includes("foundation")) return "foundation";
  return null;
}

/** Parse the CLI's explicit frame override without assigning protocol precedence. */
export function contractSourceFlag(
  value: string | boolean | undefined,
): { source?: ContractSource; error?: string } {
  if (value === undefined) return {};
  if (value === "foundation" || value === "agreement") return { source: value };
  return { error: "--contract must be `foundation` or `agreement`" };
}

/**
 * Parse `--agreement summary|full`: how another position's Agreement is read as
 * reference. Omitted keeps the protocol default (summary). The caller's own
 * Agreement is never affected.
 */
export function agreementFlag(
  value: string | boolean | undefined,
): { agreement?: ContentRepresentation; error?: string } {
  if (value === undefined) return {};
  if (value === "summary" || value === "full") return { agreement: value };
  return { error: "--agreement must be `summary` or `full`" };
}

/** Habitat cap on stale-doc signals in a rendered tail; shared by navigate and status. */
export const MAX_DRIFT = 10;
