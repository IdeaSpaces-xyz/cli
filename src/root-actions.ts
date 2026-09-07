import type { AuthMeRepo } from "./auth/api.js";

export type RootAction = "open" | "copy" | "clone" | "collaborate";

/** Evaluate one independent account-root product action. */
export function hasRootAction(repo: AuthMeRepo, action: RootAction): boolean {
  return repo.actions?.includes(action) ?? false;
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
  return "available";
}
