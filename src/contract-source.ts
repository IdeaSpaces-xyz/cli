import type { ContractSource } from "@ideaspaces/protocol";

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
