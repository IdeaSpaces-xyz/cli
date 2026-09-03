import type { AuthMeRepo } from "./auth/api.js";

export type RootAction = "open" | "copy" | "clone" | "collaborate";

/**
 * Evaluate one account-root product action.
 *
 * New servers send independent actions. The role fallback is only for rolling
 * compatibility with servers that predate the receipt contract; it disappears
 * once that minimum version is enforced.
 */
export function hasRootAction(repo: AuthMeRepo, action: RootAction): boolean {
  if (repo.actions !== undefined) return repo.actions.includes(action);

  const role = repo.role?.toUpperCase();
  if (action === "open") return ["OWNER", "MEMBER", "CLONER", "READER"].includes(role ?? "");
  if (action === "clone") return ["OWNER", "MEMBER", "CLONER"].includes(role ?? "");
  if (action === "collaborate") return ["OWNER", "MEMBER"].includes(role ?? "");
  // Old servers had no independent Copy contract; keep that fallback
  // owner-only rather than inferring new authority from a broad role.
  return role === "OWNER";
}

export function availableRootActions(repo: AuthMeRepo): RootAction[] {
  const actions: RootAction[] = ["open", "copy", "clone", "collaborate"];
  return actions.filter((action) => hasRootAction(repo, action));
}

export function rootRelationshipLabel(repo: AuthMeRepo): string {
  const receipts = repo.receipt_classes ?? [];
  if (receipts.includes("person_owner") || receipts.includes("organization_owner")) {
    return "owner";
  }
  if (receipts.includes("organization_members") || receipts.includes("organization_owners")) {
    return "team";
  }
  if (receipts.includes("direct_person")) return "shared";
  return repo.role?.toLowerCase() ?? "available";
}
