import { afterEach, expect, it } from "vitest";
import { get } from "node:http";
import { startCallbackServer, type CallbackResult } from "../auth/callback-server.js";
let server: CallbackResult | undefined;
afterEach(() => { server?.close(); server = undefined; });
const start = async () => { server = await startCallbackServer("test-state"); return `http://127.0.0.1:${server.port}/callback`; };
it("captures an immediate, one-time state-bound code even before waiting", async () => {
  const url = await start();
  expect((await fetch(`${url}?code=one-code&state=test-state`)).status).toBe(200);
  expect(await server!.waitForCallback()).toBe("one-code");
  expect((await fetch(`${url}?code=other-code&state=test-state`)).status).toBe(400);
});
it("ignores wrong/missing state, token callbacks, duplicate params, non-GET and wrong paths", async () => {
  const url = await start();
  for (const q of ["?code=x", "?code=x&state=bad", "?token=legacy&state=test-state", "?code=a&code=b&state=test-state", "?code=x&state=test-state&state=bad"]) expect((await fetch(url + q)).status).toBe(400);
  expect((await fetch(url, { method: "POST" })).status).toBe(400);
  expect((await fetch(url.replace("callback", "other"))).status).toBe(404);
  const response = await fetch(`${url}?state=test-state&code=valid`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await server!.waitForCallback()).toBe("valid");
});
it("rejects a forged Host without consuming the state", async () => {
  const url = await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    get(`${url}?state=test-state&code=bad`, { headers: { Host: "attacker.invalid" } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject);
  });
  expect(status).toBe(400);
  await fetch(`${url}?state=test-state&code=valid`);
  expect(await server!.waitForCallback()).toBe("valid");
});
it("rejects a matching-state provider refusal without echoing its contents", async () => {
  const url = await start();
  const pending = server!.waitForCallback();
  const refused = expect(pending).rejects.toThrow("not approved");
  await fetch(`${url}?state=test-state&error=private-provider-detail`);
  await refused;
});
it("bounds waits and closes pending callbacks", async () => {
  await start();
  await expect(server!.waitForCallback(5)).rejects.toThrow("timed out");
  server!.close();
  await start();
  const pending = server!.waitForCallback();
  const closed = expect(pending).rejects.toThrow("closed");
  server!.close(); await closed;
});
