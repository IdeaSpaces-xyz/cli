import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";

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
