import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepo,
  fetchAuthMe,
  putFile,
  listRepoMembers,
  createRepoInvites,
  removeRepoMember,
  setSpaceAccess,
  UnauthorizedError,
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
      copy_public: false,
      copy_access: "reader",
    });
    const a = await setSpaceAccess(config, "repo_abc", { read_public: true, copy_access: "reader" });
    expect(calls[0].init?.method).toBe("PATCH");
    expect(calls[0].url).toBe("http://api.test/api/v1/repos/repo_abc/space-access");
    expect(a.read_public).toBe(true);
  });

  it("tolerates a 204 (empty body) on member removal", async () => {
    capture(204, undefined);
    await expect(removeRepoMember(config, "repo_abc", 7)).resolves.toBeUndefined();
  });
})
