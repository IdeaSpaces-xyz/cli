import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const JSON_G: GlobalFlags = { json: true, quiet: true, yes: false, help: false };
const TEXT_G: GlobalFlags = { json: false, quiet: true, yes: false, help: false };

const {
  loadConfigMock,
  resolveSpaceBindingMock,
  addPersonShareMock,
  listPersonSharesMock,
  listPersonShareInvitesMock,
  createRepoInvitesMock,
  removePersonShareMock,
  revokePersonShareInviteMock,
  repoRootMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  resolveSpaceBindingMock: vi.fn(),
  addPersonShareMock: vi.fn(),
  listPersonSharesMock: vi.fn(),
  listPersonShareInvitesMock: vi.fn(),
  createRepoInvitesMock: vi.fn(),
  removePersonShareMock: vi.fn(),
  revokePersonShareInviteMock: vi.fn(),
  repoRootMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/resolve-space.js", () => ({ resolveSpaceBinding: resolveSpaceBindingMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    addPersonShare: addPersonShareMock,
    listPersonShares: listPersonSharesMock,
    listPersonShareInvites: listPersonShareInvitesMock,
    createRepoInvites: createRepoInvitesMock,
    removePersonShare: removePersonShareMock,
    revokePersonShareInvite: revokePersonShareInviteMock,
  };
});
vi.mock("../git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git.js")>();
  return { ...actual, repoRoot: repoRootMock };
});

const { shareCommand } = await import("../commands/share.js");

const ROOT = "n_0123456789abcdef01234567";
let stdout: string;
let stderr: string;

function addResult(over: Record<string, unknown> = {}) {
  return {
    target_node_id: ROOT,
    grade: "explore",
    share_history: false,
    status: "added",
    recipient_route: `https://example.test/spaces/${ROOT}`,
    relationship: {
      user_id: 7,
      username: "bob",
      email: "bob@example.com",
      account_status: "active",
      access: "view",
      share_history: false,
    },
    pending_invite: null,
    ...over,
  };
}

beforeEach(() => {
  for (const m of [
    loadConfigMock,
    resolveSpaceBindingMock,
    addPersonShareMock,
    listPersonSharesMock,
    listPersonShareInvitesMock,
    createRepoInvitesMock,
    removePersonShareMock,
    revokePersonShareInviteMock,
    repoRootMock,
  ]) {
    m.mockReset();
  }
  loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
  repoRootMock.mockReturnValue("/clone");
  resolveSpaceBindingMock.mockResolvedValue({ rootNodeId: ROOT, via: "record" });
  addPersonShareMock.mockResolvedValue(addResult());
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    stdout += typeof c === "string" ? c : Buffer.from(c).toString("utf-8");
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => {
    stderr += typeof c === "string" ? c : Buffer.from(c).toString("utf-8");
    return true;
  }) as typeof process.stderr.write);
});

describe("share invite — a grade on a Space, not a seat in a repo", () => {
  it("invites from the folder you are standing in, with no repo_id anywhere", async () => {
    expect(await shareCommand.run(["invite", "bob@example.com"], {}, JSON_G)).toBe(0);

    // The done-when's first clause: the owner never discovers an internal
    // repository identifier to share what they are looking at.
    expect(addPersonShareMock).toHaveBeenCalledWith(expect.anything(), ROOT, {
      email: "bob@example.com",
      invite_if_no_match: true,
      grade: "explore",
      share_history: false,
    });
    const out = JSON.parse(stdout);
    expect(out.grade).toBe("explore");
    expect(out.status).toBe("added");
    expect(out.relationship.username).toBe("bob");
  });

  it("carries the grade and the trail when asked", async () => {
    addPersonShareMock.mockResolvedValue(addResult({ grade: "collaborate", share_history: true }));

    expect(
      await shareCommand.run(["invite", "bob@example.com"], { grade: "collaborate", history: true }, JSON_G),
    ).toBe(0);

    expect(addPersonShareMock).toHaveBeenCalledWith(
      expect.anything(),
      ROOT,
      expect.objectContaining({ grade: "collaborate", share_history: true }),
    );
    expect(JSON.parse(stdout).grade).toBe("collaborate");
  });

  it("refuses a grade the product does not have", async () => {
    expect(await shareCommand.run(["invite", "bob@example.com"], { grade: "owner" }, JSON_G)).toBe(1);
    expect(stderr).toContain("explore, fork, collaborate");
    expect(addPersonShareMock).not.toHaveBeenCalled();
  });

  it("reports an unknown address as invited rather than as failure", async () => {
    addPersonShareMock.mockResolvedValue(
      addResult({
        status: "invited",
        relationship: null,
        pending_invite: {
          invite_id: "inv_1",
          invited_email: "new@example.com",
          intent_kind: "content",
          grade: "fork",
          share_history: false,
          created_at: "2026-08-11T00:00:00Z",
          expires_at: "2026-08-18T00:00:00Z",
          delivery_status: "sent",
          can_resend: false,
        },
        grade: "fork",
      }),
    );

    expect(await shareCommand.run(["invite", "new@example.com"], { grade: "fork" }, TEXT_G)).toBe(0);
    expect(stdout).toContain("No account yet");
    expect(stdout).toContain("fork");
  });

  it("says an existing relationship was left alone rather than silently reporting success", async () => {
    // The done-when asks for independently held access to be *reported*, not
    // absorbed: someone else granted this, and we did not change it.
    addPersonShareMock.mockResolvedValue(addResult({ status: "already_direct" }));

    expect(await shareCommand.run(["invite", "bob@example.com"], {}, TEXT_G)).toBe(0);
    expect(stdout).toContain("already has direct access");
    expect(stdout).toContain("Nothing changed");
  });

  it("names a Space explicitly when you are not standing in one", async () => {
    repoRootMock.mockImplementation(() => {
      throw new Error("not inside a git repository");
    });

    const code = await shareCommand.run(
      ["invite", "bob@example.com"],
      { space: `https://example.test/spaces/${ROOT}` },
      JSON_G,
    );

    expect(code).toBe(0);
    expect(addPersonShareMock).toHaveBeenCalledWith(expect.anything(), ROOT, expect.anything());
    // An explicit target needs no binding lookup at all.
    expect(resolveSpaceBindingMock).not.toHaveBeenCalled();
  });

  it("says which way it could not tell, when the clone is unbound", async () => {
    resolveSpaceBindingMock.mockResolvedValue({ failure: "ambiguous" });

    expect(await shareCommand.run(["invite", "bob@example.com"], {}, JSON_G)).toBe(1);
    expect(stderr).toContain("more than one");
    expect(addPersonShareMock).not.toHaveBeenCalled();
  });

  it("refuses outside a Space with the way out", async () => {
    repoRootMock.mockImplementation(() => {
      throw new Error("not inside a git repository");
    });

    expect(await shareCommand.run(["invite", "bob@example.com"], {}, JSON_G)).toBe(1);
    expect(stderr).toContain("--space");
  });
});

describe("share people — who holds this, including what we did not grant", () => {
  it("lists accepted relationships and outstanding invitations together", async () => {
    listPersonSharesMock.mockResolvedValue({
      target_node_id: ROOT,
      target_type: "repo",
      recipient_route: "r",
      actions: { can_manage_existing: true, can_add: true },
      relationships: [
        { user_id: 7, username: "bob", account_status: "active", access: "view", share_history: true },
      ],
    });
    listPersonShareInvitesMock.mockResolvedValue({
      invites: [{ invited_email: "new@example.com", grade: "fork" }],
    });

    expect(await shareCommand.run(["people"], {}, TEXT_G)).toBe(0);
    // Neither half answers "who has this" alone: one accepted, one has not yet.
    expect(stdout).toContain("bob");
    expect(stdout).toContain("+ history");
    expect(stdout).toContain("new@example.com");
    expect(stdout).toContain("invited (fork)");
  });

  it("surfaces why adding is blocked instead of showing an empty list", async () => {
    listPersonSharesMock.mockResolvedValue({
      target_node_id: ROOT,
      target_type: "repo",
      recipient_route: "r",
      actions: { can_manage_existing: false, can_add: false, add_blocked_reason: "not_owner" },
      relationships: [],
    });
    listPersonShareInvitesMock.mockResolvedValue({ invites: [] });

    expect(await shareCommand.run(["people"], {}, TEXT_G)).toBe(0);
    expect(stdout).toContain("not_owner");
  });
});

describe("the role vocabulary is gone from new invitations", () => {
  it("points CLONER at the grade that replaced it", async () => {
    expect(
      await shareCommand.run(["legacy-invite", "repo_abc", "bob@example.com"], { role: "CLONER" }, JSON_G),
    ).toBe(1);
    expect(stderr).toContain("--grade fork");
    expect(createRepoInvitesMock).not.toHaveBeenCalled();
  });

  it("keeps the compatibility path for the roles that still mean something", async () => {
    createRepoInvitesMock.mockResolvedValue({ results: [{ email: "bob@example.com", status: "invited" }] });

    expect(
      await shareCommand.run(["legacy-invite", "repo_abc", "bob@example.com"], { role: "MEMBER" }, JSON_G),
    ).toBe(0);
    expect(createRepoInvitesMock).toHaveBeenCalledWith(
      expect.anything(),
      "repo_abc",
      ["bob@example.com"],
      "MEMBER",
    );
  });

  it("never sends a role for a new invitation", async () => {
    await shareCommand.run(["invite", "bob@example.com"], { grade: "fork" }, JSON_G);

    expect(createRepoInvitesMock).not.toHaveBeenCalled();
    const body = addPersonShareMock.mock.calls[0][2];
    expect(JSON.stringify(body)).not.toMatch(/MEMBER|CLONER|READER|role/i);
  });
});

describe("share invite — one person at a time", () => {
  it("refuses a list rather than inviting the first and dropping the rest", async () => {
    // The verb this replaced took a list. Silently honouring only the first
    // address would be the exact surprise this command's reporting exists to
    // avoid.
    expect(
      await shareCommand.run(["invite", "a@x.com", "b@x.com"], { grade: "fork" }, JSON_G),
    ).toBe(1);
    expect(stderr).toContain("b@x.com");
    expect(addPersonShareMock).not.toHaveBeenCalled();
  });
});

describe("share unshare — the undo", () => {
  beforeEach(() => {
    listPersonSharesMock.mockResolvedValue({
      target_node_id: ROOT,
      target_type: "repo",
      recipient_route: "r",
      actions: { can_manage_existing: true, can_add: true },
      relationships: [
        { user_id: 7, username: "bob", email: "bob@example.com", account_status: "active", access: "view", share_history: false },
      ],
    });
    listPersonShareInvitesMock.mockResolvedValue({
      invites: [{ invite_id: "inv_1", invited_email: "new@example.com", grade: "fork" }],
    });
  });

  it("removes an accepted relationship by the address you shared with", async () => {
    expect(await shareCommand.run(["unshare", "bob@example.com"], {}, JSON_G)).toBe(0);
    expect(removePersonShareMock).toHaveBeenCalledWith(expect.anything(), ROOT, 7);
    expect(revokePersonShareInviteMock).not.toHaveBeenCalled();
  });

  it("withdraws an invitation nobody accepted, from the same address", async () => {
    // The person undoing knows who they shared with, not whether that person
    // ever accepted — so one verb resolves which of the two it is.
    expect(await shareCommand.run(["unshare", "new@example.com"], {}, JSON_G)).toBe(0);
    expect(revokePersonShareInviteMock).toHaveBeenCalledWith(expect.anything(), ROOT, "inv_1");
    expect(removePersonShareMock).not.toHaveBeenCalled();
  });

  it("says nothing was undone rather than reporting success", async () => {
    expect(await shareCommand.run(["unshare", "stranger@example.com"], {}, JSON_G)).toBe(1);
    expect(stderr).toContain("no direct access");
    expect(removePersonShareMock).not.toHaveBeenCalled();
    expect(revokePersonShareInviteMock).not.toHaveBeenCalled();
  });
});

describe("share people — an unread half is not an empty half", () => {
  it("says the invitations could not be read instead of showing none", async () => {
    listPersonSharesMock.mockResolvedValue({
      target_node_id: ROOT,
      target_type: "repo",
      recipient_route: "r",
      actions: { can_manage_existing: true, can_add: true },
      relationships: [],
    });
    listPersonShareInvitesMock.mockRejectedValue(new Error("403 not permitted"));

    expect(await shareCommand.run(["people"], {}, JSON_G)).toBe(0);
    const out = JSON.parse(stdout);
    // A scripted caller must be able to tell "nobody is invited" from "we could
    // not find out".
    expect(out.invites_unavailable).toContain("403");
    expect(out.pending_invites).toEqual([]);
  });
});
