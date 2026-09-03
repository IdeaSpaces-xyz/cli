import { describe, expect, it } from "vitest";
import type { AuthMeRepo } from "../auth/api.js";
import { rootRelationshipLabel } from "../root-actions.js";

function repo(receiptClass: string): AuthMeRepo {
  return {
    repo_id: "repo_test",
    receipt_classes: [receiptClass],
    actions: [],
  };
}

describe("root relationship labels", () => {
  it.each(["person_owner", "organization_owner"])(
    "maps canonical ownership receipt %s to owner",
    (receiptClass) => {
      expect(rootRelationshipLabel(repo(receiptClass))).toBe("owner");
    },
  );

  it.each(["organization_members", "organization_owners"])(
    "maps explicit organization userset %s to team",
    (receiptClass) => {
      expect(rootRelationshipLabel(repo(receiptClass))).toBe("team");
    },
  );

  it("maps a direct-person receipt to shared", () => {
    expect(rootRelationshipLabel(repo("direct_person"))).toBe("shared");
  });
});
