import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePiStatus, resolveExtension } from "../commands/pi-status.js";
import type { PiBinary, PiExtensionCheck } from "../commands/pi-status.js";
import type { PiAuth } from "../pi-auth.js";

const NOW = 1_800_000_000_000; // fixed clock
const present: PiBinary = { present: true, path: "pi", version: "0.80.3" };
const absent: PiBinary = { present: false, path: "pi", version: null };
const ext = (name: string, resolvable: boolean): PiExtensionCheck => ({ name, path: `/x/${name}`, resolvable });

describe("derivePiStatus", () => {
  it("is ready when the binary is present and a provider has creds", () => {
    const auth: PiAuth = { anthropic: { access: "a", refresh: "r", expires: NOW + 1000 } };
    const s = derivePiStatus({ binary: present, auth, extensions: [], now: NOW });
    expect(s.ready).toBe(true);
    expect(s.configured).toBe(true);
    expect(s.providers).toEqual([{ name: "anthropic", hasCreds: true, expiresAt: NOW + 1000, expired: false }]);
  });

  it("counts an expired-but-refreshable provider as configured, flagged expired", () => {
    const auth: PiAuth = { openai: { access: "a", refresh: "r", expires: NOW - 1000 } };
    const s = derivePiStatus({ binary: present, auth, extensions: [], now: NOW });
    expect(s.configured).toBe(true); // refresh token renews it
    expect(s.providers[0].expired).toBe(true);
    expect(s.ready).toBe(true);
  });

  it("is not configured when a provider carries no creds", () => {
    const auth: PiAuth = { ghost: { expires: NOW + 1000 } };
    const s = derivePiStatus({ binary: present, auth, extensions: [], now: NOW });
    expect(s.providers[0].hasCreds).toBe(false);
    expect(s.configured).toBe(false);
    expect(s.ready).toBe(false);
  });

  it("counts a pi api_key credential as configured (the shape pi-login --api-key writes)", () => {
    // pi's tagged union: `{ type: "api_key", key }` — no access/refresh. The
    // earlier hasCreds check keyed only on access/refresh, so this read as
    // unconfigured and the login→recheck loop never flipped to ready.
    const auth: PiAuth = { anthropic: { type: "api_key", key: "sk-ant-…" } };
    const s = derivePiStatus({ binary: present, auth, extensions: [], now: NOW });
    expect(s.providers[0].hasCreds).toBe(true);
    expect(s.providers[0].expiresAt).toBeNull(); // an API key has no expiry
    expect(s.providers[0].expired).toBe(false);
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(true);
  });

  it("counts a pi oauth credential (typed union form) as configured", () => {
    const auth: PiAuth = {
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW + 1000 },
    };
    const s = derivePiStatus({ binary: present, auth, extensions: [], now: NOW });
    expect(s.providers[0].hasCreds).toBe(true);
    expect(s.configured).toBe(true);
  });

  it("is not ready when the binary is absent, even with a provider", () => {
    const auth: PiAuth = { anthropic: { access: "a" } };
    const s = derivePiStatus({ binary: absent, auth, extensions: [], now: NOW });
    expect(s.ready).toBe(false);
  });

  it("null auth yields no providers and not configured", () => {
    const s = derivePiStatus({ binary: present, auth: null, extensions: [], now: NOW });
    expect(s.providers).toEqual([]);
    expect(s.configured).toBe(false);
  });

  it("extensionsResolvable is true only when all supplied extensions resolve", () => {
    const auth: PiAuth = { anthropic: { access: "a" } };
    const all = derivePiStatus({ binary: present, auth, extensions: [ext("a", true), ext("b", true)], now: NOW });
    expect(all.extensionsResolvable).toBe(true);
    const some = derivePiStatus({ binary: present, auth, extensions: [ext("a", true), ext("b", false)], now: NOW });
    expect(some.extensionsResolvable).toBe(false);
  });

  it("extensionsResolvable is false when none are supplied (nothing checked)", () => {
    const s = derivePiStatus({ binary: present, auth: { a: { access: "x" } }, extensions: [], now: NOW });
    expect(s.extensionsResolvable).toBe(false);
    expect(s.ready).toBe(true); // extensions don't gate readiness
  });
});

describe("resolveExtension", () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "pi-ext-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves a dir with a pi.extensions manifest", async () => {
    const pkgDir = join(dir, "pi-is-space");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    expect(resolveExtension(pkgDir)).toEqual({ name: "pi-is-space", path: pkgDir, resolvable: true });
  });

  it("resolves a dir with index.ts (no manifest)", async () => {
    const pkgDir = join(dir, "plain");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.ts"), "export default () => {};");
    expect(resolveExtension(pkgDir).resolvable).toBe(true);
  });

  it("does not resolve a dir with neither a manifest nor an index", async () => {
    const pkgDir = join(dir, "empty");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "empty" }));
    expect(resolveExtension(pkgDir).resolvable).toBe(false);
  });

  it("resolves a direct .ts entry file and reports its basename", async () => {
    const file = join(dir, "entry.ts");
    await writeFile(file, "export default () => {};");
    expect(resolveExtension(file)).toEqual({ name: "entry.ts", path: file, resolvable: true });
  });

  it("does not resolve a nonexistent path", () => {
    expect(resolveExtension(join(dir, "nope")).resolvable).toBe(false);
  });
});
