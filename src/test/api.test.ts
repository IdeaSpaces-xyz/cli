import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepo, fetchAuthMe, putFile, UnauthorizedError } from "../auth/api.js";

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
