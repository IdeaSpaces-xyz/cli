import type { ContractSource } from "@ideaspaces/protocol";

/** CLI habitat policy above the protocol's deliberately neutral source selection. */
export function preferredContractSource(
  available: readonly ContractSource[],
): ContractSource | null {
  if (available.includes("agreement")) return "agreement";
  if (available.includes("foundation")) return "foundation";
  return null;
}
