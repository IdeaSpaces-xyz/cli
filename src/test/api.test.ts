import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepo,
  fetchAuthMe,
  getSpace,
  getSpaceCopySnapshot,
  putFile,
  listRepoMembers,
  createRepoInvites,
  removeRepoMember,
  setSpaceAccess,
  listEligibleTeamAudiences,
  listTeamShares,
  setTeamShare,
  removeTeamShare,
  fetchInbox,
  fetchExchange,
  sendInquiry,
  replyToExchange,
  UnauthorizedError,
  NetworkError,
} from "../auth/api.js";

const config = { apiUrl: "http://api.test", apiKey: "k" };

// A fetch that hangs until its AbortSignal fires, then rejects with AbortError —
// i.e. a request that always times out (the cold-start case).
function abortingFetch() {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request() retry on timeout (cold start)", () => {
  it("retries a GET once when the first attempt times out, then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (calls === 1) {
          // First attempt: hang → AbortError (server cold).
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        }
        // Second attempt: server warm.
        return Promise.resolve(
          new Response(JSON.stringify({ username: "alice", repos: [] }), { status: 200 }),
        );
      }),
    );

    const me = await fetchAuthMe(config, { timeoutMs: 20 });
    expect(me.username).toBe("alice");
    expect(calls).toBe(2);
  });

  it("gives up after one retry if the GET keeps timing out", async () => {
    const fetchMock = abortingFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuthMe(config, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when retry:false (latency-sensitive callers)", async () => {
    const fetchMock = abortingFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuthMe(config, { timeoutMs: 20, retry: false })).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a POST on timeout (could double-apply)", async () => {
    const fetchMock = abortingFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createRepo(config, { name: "x" }, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a NetworkError with a Cowork-aware redirect when the host is unreachable", async () => {
    // undici throws `TypeError: fetch failed` for connect/DNS failures — the
    // Cowork sandbox block manifests here, not as an HTTP status.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const err = await fetchAuthMe(config, { retry: false }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/unreachable/i);
    expect(err.message).toMatch(/Claude Code view/);
  });

  it("does not retry a non-timeout error (401)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }),
    );

    await expect(fetchAuthMe(config)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toBe(1);
  });
});

describe("Space locator and copy API", () => {
  it("gets a Space through stable root identity", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              kind: "space",
              node_id: "n_0123456789abcdef01234567",
              container_node_id: "n_0123456789abcdef01234567",
              name: "Manual",
              canonical_url: "/spaces/n_0123456789abcdef01234567",
              copy_enabled: true,
              login_required_to_copy: false,
              summary: null,
              readme_markdown: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const source = await getSpace(config, "n_0123456789abcdef01234567");

    expect(source.copy_enabled).toBe(true);
    expect(captured?.url).toBe("http://api.test/api/v1/spaces/n_0123456789abcdef01234567");
    expect(captured?.init?.method).toBe("GET");
  });

  it("gets the complete clean-copy snapshot by stable source identity", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              source_head: "a".repeat(40),
              markdown_file_count: 1,
              markdown_bytes: 10,
              files: [{ path: "_agent/guide.md", content: "Guide" }],
              asset_file_count: 1,
              asset_bytes: 7,
              assets: [{ path: "_assets/picture.png", content_base64: "cGF5bG9hZA==" }],
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const snapshot = await getSpaceCopySnapshot(
      config,
      "n_0123456789abcdef01234567",
    );

    expect(snapshot.files[0].path).toBe("_agent/guide.md");
    expect(snapshot.assets[0].path).toBe("_assets/picture.png");
    expect(captured?.url).toBe(
      "http://api.test/api/v1/spaces/n_0123456789abcdef01234567/copy-snapshot",
    );
    expect(captured?.init?.method).toBe("GET");
    expect((captured?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("omits Authorization entirely for credential-free public reads", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve(
          new Response(
            JSON.stringify({
              kind: "space",
              node_id: "n_0123456789abcdef01234567",
              container_node_id: "n_0123456789abcdef01234567",
              name: "Guide",
              canonical_url: "/spaces/n_0123456789abcdef01234567",
              copy_enabled: true,
              login_required_to_copy: false,
              summary: null,
              readme_markdown: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await getSpace({ apiUrl: "http://api.test" }, "n_0123456789abcdef01234567");
    await getSpace({ apiUrl: "http://api.test", apiKey: "   " }, "n_0123456789abcdef01234567");

    for (const call of calls) {
      expect(call.headers).not.toHaveProperty("Authorization");
    }
  });
});

describe("putFile", () => {
  it("PUTs JSON content to the per-segment-encoded files path with auth", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return Promise.resolve(
          new Response(JSON.stringify({ path: "notes/a b.md", commit_sha: "abc", node_id: "n1" }), {
            status: 200,
          }),
        );
      }),
    );

    const res = await putFile(config, "repo_abc", "notes/a b.md", "# Hi");

    expect(captured?.init?.method).toBe("PUT");
    // `/` between segments stays a real slash; the space inside a segment is encoded.
    expect(captured?.url).toBe("http://api.test/api/v1/repos/repo_abc/files/notes/a%20b.md");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ content: "# Hi" });
    expect((captured?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(res.node_id).toBe("n1");
  });

  it("rejects on a 403 (no write access)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 }))));
    await expect(putFile(config, "repo_abc", "a.md", "x")).rejects.toThrow();
  });
})

describe("sharing (members / invites / access)", () => {
  function capture(status: number, body: unknown) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Promise.resolve(
          new Response(body === undefined ? null : JSON.stringify(body), { status }),
        );
      }),
    );
    return calls;
  }

  it("lists members (GET /members)", async () => {
    const calls = capture(200, [{ user_id: 1, username: "a", email: null, role: "OWNER" }]);
    const members = await listRepoMembers(config, "repo_abc");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(calls[0].url).toBe("http://api.test/api/v1/repos/repo_abc/members");
    expect(members[0].role).toBe("OWNER");
  });

  it("creates invites (POST /invites with emails + role)", async () => {
    const calls = capture(200, { results: [{ email: "a@x.com", status: "sent" }] });
    const res = await createRepoInvites(config, "repo_abc", ["a@x.com"], "MEMBER");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ emails: ["a@x.com"], role: "MEMBER" });
    expect(res.results[0].status).toBe("sent");
  });

  it("sets access (PATCH /space-access)", async () => {
    const calls = capture(200, {
      repo_id: "repo_abc",
      root_node_id: "n",
      read_public: true,
      copy_public: true,
      copy_access: "public",
    });
    const a = await setSpaceAccess(config, "repo_abc", { read_public: true, copy_access: "public" });
    expect(calls[0].init?.method).toBe("PATCH");
    expect(calls[0].url).toBe("http://api.test/api/v1/repos/repo_abc/space-access");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      read_public: true,
      copy_access: "public",
    });
    expect(a.read_public).toBe(true);
  });

  it("resolves a hostname through eligible team audiences", async () => {
    const calls = capture(200, [{
      audience: "org_members",
      hostname: "acme.com",
      org_node_id: "n_org",
      grantee: "node:n_org:members",
      label: "Acme",
      role: "OWNER",
    }]);
    const teams = await listEligibleTeamAudiences(config);
    expect(calls[0].url).toBe("http://api.test/api/v1/nodes/grant-audiences");
    expect(teams[0].org_node_id).toBe("n_org");
  });

  it("lists, sets, and removes root team grades", async () => {
    const calls = capture(200, {
      target_node_id: "n_root",
      relationships: [],
      status: "shared",
    });
    await listTeamShares(config, "n_root");
    await setTeamShare(config, "n_root", "n_org", "collaborate");
    await removeTeamShare(config, "n_root", "n_org");

    expect(calls.map((call) => [call.init?.method ?? "GET", call.url])).toEqual([
      ["GET", "http://api.test/api/v1/nodes/n_root/team-shares"],
      ["PUT", "http://api.test/api/v1/nodes/n_root/team-shares/n_org"],
      ["DELETE", "http://api.test/api/v1/nodes/n_root/team-shares/n_org"],
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ grade: "collaborate" });
  });

  it("tolerates a 204 (empty body) on member removal", async () => {
    capture(204, undefined);
    await expect(removeRepoMember(config, "repo_abc", 7)).resolves.toBeUndefined();
  });
})

describe("direct Inbox API", () => {
  it("calls the four person-authenticated exchange routes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const path = String(url);
        const body = path.endsWith("/inbox")
          ? { items: [] }
          : path.includes("/replies") || path.endsWith("/inquiries")
            ? {
                note_node_id: "n_note",
                exchange_id: "x_one",
                event_id: "evt_one",
                position: 1,
                created_at: "2026-08-29T00:00:00Z",
                target_node_id: "n_target",
                author_ref: "person:user_1",
                recipient_ref: "person:user_2",
                actor_ref: "person:user_1",
                surface: "human",
                action: path.includes("/replies") ? "note.replied" : "inquiry.opened",
              }
            : {
                mode: "direct",
                exchange_id: "x_one",
                target_node_id: "n_target",
                participants: [],
                messages: [],
              };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );

    const note = {
      send_id: "send-one",
      name: "Question",
      summary: "A focused question",
      markdown: "# Question",
    };
    await fetchInbox(config);
    await fetchExchange(config, "x_one");
    await sendInquiry(config, {
      ...note,
      target_node_id: "n_target",
      recipient: { username: "two" },
    });
    await replyToExchange(config, "x_one", { ...note, send_id: "reply-one" });

    expect(calls.map((call) => [call.init?.method ?? "GET", call.url])).toEqual([
      ["GET", "http://api.test/api/v1/inbox"],
      ["GET", "http://api.test/api/v1/exchanges/x_one"],
      ["POST", "http://api.test/api/v1/inquiries"],
      ["POST", "http://api.test/api/v1/exchanges/x_one/replies"],
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      send_id: "send-one",
      target_node_id: "n_target",
      recipient: { username: "two" },
    });
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({ send_id: "reply-one" });
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
    }
  });
});

describe("describeTrailRefusal", () => {
  // The server answers 404 for every refusal so a stranger probing root node
  // ids learns nothing. The reason code rides in the detail; these turn it into
  // something the holder of a clone can act on.
  const notFound = (detail: string) =>
    new Error(`GET /api/v1/spaces/n_x/git?op=log → 404: {"detail":"${detail}"}`);

  it("separates 'not shared' from 'does not exist'", async () => {
    const { describeTrailRefusal } = await import("../auth/api.js");
    const note = describeTrailRefusal(notFound("Space not found (no_history_relation)"));
    expect(note).toContain("trail has not been shared with you");
    // The thing a person standing in a clone must never be told.
    expect(note).not.toContain("could not be found");
  });

  it("explains a withdrawn read as separate from the local clone", async () => {
    const { describeTrailRefusal } = await import("../auth/api.js");
    const note = describeTrailRefusal(notFound("Space not found (no_read_relation)"));
    expect(note).toContain("no longer have read access");
    expect(note).toContain("local clone is unaffected");
  });

  it("falls back to a real not-found for a 404 with no reason code", async () => {
    const { describeTrailRefusal } = await import("../auth/api.js");
    const note = describeTrailRefusal(notFound("Space not found"));
    expect(note).toContain("could not be found");
    expect(note).toContain("ideaspaces link");
  });

  it("does not tell a fork to re-link itself when its source is gone", async () => {
    const { describeTrailRefusal } = await import("../auth/api.js");
    const note = describeTrailRefusal(notFound("Space not found"), "source");
    expect(note).toContain("recorded source Space could not be found");
    expect(note).not.toContain("ideaspaces link");
  });

  it("declines anything that is not one of its refusals", async () => {
    const { describeTrailRefusal } = await import("../auth/api.js");
    expect(describeTrailRefusal(new Error("GET /x → 500: boom"))).toBeNull();
    expect(describeTrailRefusal(new Error("socket hang up"))).toBeNull();
    expect(describeTrailRefusal("not an error at all")).toBeNull();
  });
});
