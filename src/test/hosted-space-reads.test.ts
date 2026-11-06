import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchHostedSpace, fetchHostedSpaces } from "../auth/api.js";
const config = { apiUrl: "http://localhost:1234", apiKey: "fixture-person" };
beforeEach(() => { vi.stubEnv("IDEASPACES_AUTH", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("gives an actionable error for malformed list and head responses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  await expect(fetchHostedSpaces(config)).rejects.toThrow("unreadable Spaces list");
  await expect(fetchHostedSpace(config, "n_" + "a".repeat(24))).rejects.toThrow("unreadable Space");
});
it("accepts an empty list and a no-member head", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"maps":[]}', { status: 200 })));
  await expect(fetchHostedSpaces(config)).resolves.toEqual({ maps: [] });
  const head = { map_id: "n_" + "a".repeat(24), version_id: "n_" + "b".repeat(24), authored: { label: "Limited" }, members: null, omitted_members: 2 };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(head), { status: 200 })));
  await expect(fetchHostedSpace(config, head.map_id)).resolves.toEqual(head);
});
