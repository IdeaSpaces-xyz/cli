import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCatalog, canonicalJSON, composeDescription, discover, entries, groups, validateEntries } from "../agent-tools/catalog.js";
import { allowedFlags, catalogFlagError, resolveEntry } from "../agent-tools/flags.js";
import { agentRunCapabilities } from "../local/agent-capabilities.js";
import { findCommand_ } from "../router.js";
import type { Entry } from "../agent-tools/types.js";

const catalog = () => buildCatalog({ version: "test", commit: "a".repeat(40) }, { version: "test", commit: "b".repeat(40) });
const schema = JSON.parse(readFileSync(new URL("../agent-tools/agent-tools.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

describe("agent tool contract data", () => {
  it("validates the complete catalog and permits the same format for a host entry", () => {
    const data = catalog();
    expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    expect(groups.map(g => g.job)).toEqual(Array.from({ length: 14 }, (_, i) => `J${i + 1}`));
    expect(entries.filter(e => e.owner === "cli" && e.status === "active")).toHaveLength(100);
    expect(entries.filter(e => e.status === "retired").map(e => e.id)).toEqual(["follow", "unfollow", "threads.posts", "threads.expand", "threads.add"]);
    expect(entries.filter(e => e.owner === "host").map(e => e.id)).toEqual(["change.open", "change.close", "session.status"]);
    for (const host of entries.filter(e => e.owner === "host")) {
      expect(host.implemented_by).toEqual(["mcp", "pi"]);
      expect(host.cli).toBeUndefined();
    }
  });

  it.each(["check", "bound"] as const)("rejects empty, missing and whitespace-only text.%s", field => {
    for (const invalid of ["", " \n\t", undefined]) {
      const data = catalog();
      const first = structuredClone(data.entries[0]);
      if (invalid === undefined) delete (first.text as Partial<Entry["text"]>)[field];
      else first.text[field] = invalid;
      data.entries = [first];
      expect(validate(data)).toBe(false);
      if (invalid !== undefined) expect(() => validateEntries([first])).toThrow(`empty text.${field}`);
    }
  });

  it("bounds individual text fields by characters and composed descriptions by UTF-8 bytes", () => {
    const entry = structuredClone(entries[0]);
    entry.text.check = "x".repeat(301);
    expect(() => validateEntries([entry])).toThrow("300 characters");
    for (const key of Object.keys(entry.text) as (keyof Entry["text"])[]) entry.text[key] = "界".repeat(150);
    expect(() => validateEntries([entry])).toThrow("1200 bytes");
    expect(composeDescription(entries[0])).toBe(Object.values(entries[0].text).join("\n"));
  });

  it("has deterministic key-sorted entry digests, distinct from build metadata", () => {
    expect(canonicalJSON({ z: [{ b: 2, a: 1 }], a: 0 })).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
    expect(catalog().digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(buildCatalog({ version: "other", commit: "c".repeat(40) }, catalog().protocol).digest).toBe(catalog().digest);
    const copy = structuredClone(entries);
    copy[0].text.check += "!";
    expect(canonicalJSON(copy)).not.toBe(canonicalJSON(entries));
  });

  it("fails the build drift check when implementation reads an undeclared flag", async () => {
    const { checkSourceFlags } = await import("../../scripts/check-agent-tools.mjs");
    expect(() => checkSourceFlags()).not.toThrow();
    expect(() => checkSourceFlags((path: string) => readFileSync(path, "utf8") + (path.endsWith("commands/look.ts") ? '\nfunction drift(flags: any) { return flags["future-flag"]; }' : ""))).toThrow("--future-flag is read but not catalogued");
  });

  it("covers all six J11.8 runtime entries without inventing host sign-in authority", () => {
    for (const id of ["pi.status", "pi.models", "pi.login", "pi.logout", "claude.status", "claude.models"]) {
      const entry = entries.find(e => e.id === id)!;
      expect(entry.job).toBe("J11");
      expect(entry.reach).toBe("local");
      expect(entry.effect).toBe(id.endsWith("login") || id.endsWith("logout") ? "account" : "status");
      expect(entry.cli?.argv).toEqual([id.replace(".", "-")]);
    }
    expect(catalog().exclusions.map(e => e.id)).toEqual(expect.arrayContaining(["agent_session", "is_cli", "is_share"]));
    for (const id of ["agent_session", "is_cli", "is_share"]) expect(entries.find(e => e.id === id)).toBeUndefined();
  });

  it("discloses groups, brief entries, then one complete contract", () => {
    const data = catalog();
    const root = discover(data);
    expect(root.groups).toEqual(groups);
    expect(root.entries).toBeUndefined();
    expect(root.unbounded).toContain("times");
    const group = discover(data, "threads");
    expect(group.entries).toEqual(data.entries.filter(e => e.job === "J4").map(e => ({ id: e.id, does: e.text.does, use_when: e.text.use_when })));
    expect(discover(data, "J4")).toEqual(group);
    const full = discover(data, "threads.post");
    expect(full.entry).toEqual(entries.find(e => e.id === "threads.post"));
    for (const id of ["write", "commit", "search", "agents"]) expect(discover(data, id).entry).toHaveProperty("id", id);
    expect(() => discover(data, "unknown")).toThrow("Unknown capabilities");
    expect(() => discover(data, "__proto__")).toThrow("Unknown capabilities");
  });

  it("keeps look paging and local post kinds in the downstream catalog cut", () => {
    const look = entries.find(e => e.id === "look")!;
    expect(Object.keys(look.parameters.properties!)).toEqual(expect.arrayContaining(["limit", "order", "since", "post", "agreement"]));
    expect(look.text.check).not.toContain("Thread summaries show folded marks");
    expect(look.text.check).toContain("Open the post for body evidence");
    const post = entries.find(e => e.id === "threads.post")!;
    expect(post.parameters.properties!.kind.enum).toEqual(expect.arrayContaining(["snapshot", "correction", "mark"]));
    expect(post.cli!.flags.kind.flag).toBe("--kind");
    expect(post.parameters.properties!.supersedes).toBeDefined();
  });

  it("retains the existing transport and run schema documents unchanged", () => {
    expect(catalog().capabilities.threads).toEqual({ schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: false });
    expect(catalog().capabilities.agent).toEqual(agentRunCapabilities());
    expect(discover(catalog(), "agent.capabilities").capabilities).toEqual(agentRunCapabilities());
  });

  it("resolves the frozen compatibility words and never maps shared host state to a fake CLI verb", () => {
    for (const [command, args, id] of [
      ["threads", ["read", "local"], "threads.open"], ["request", ["incoming"], "request.list"], ["request", ["decline", "r_id"], "request.deny"],
      ["map", ["local.map.md"], "map.read"], ["skills", ["capture"], "skills.read"], ["spaces", [], "spaces.list"],
    ] as const) expect(resolveEntry(command, [...args])?.id).toBe(id);
    expect(resolveEntry("change", ["open"])).toBeUndefined();
    expect(entries.find(e => e.id === "whoami")?.aliases).toContain("status account");
    expect(entries.find(e => e.id === "logout")?.aliases).toContain("power logout");
  });

  it("accepts every declared flag at the actual CLI boundary and rejects undeclared flags before command execution", () => {
    for (const entry of entries.filter(e => e.owner === "cli" && e.status === "active")) {
      const [command, ...verbs] = entry.cli!.argv;
      if (command === "--version") continue; // argv global route, not a command definition
      expect(findCommand_(command), entry.id).toBeDefined();
      expect(resolveEntry(command, verbs)?.id, entry.id).toBe(entry.id);
      for (const flag of allowedFlags(entry.id)) expect(catalogFlagError(command, verbs, { [flag]: "--literal-value" }), `${entry.id} --${flag}`).toBeUndefined();
      expect(catalogFlagError(command, verbs, { "not-a-declared-flag": true }), entry.id).toContain("--not-a-declared-flag");
    }
    expect(catalogFlagError("spaces", ["open", "n_0123456789ab"], { hosted: true })).toBeUndefined();
    expect(catalogFlagError("agent", ["run", "pov"], { "claude-auth": "api-key", "model-tier": "local" })).toBeUndefined();
    expect(allowedFlags("threads.post", "hosted").has("kind")).toBe(false);
    expect(allowedFlags("threads.post", "local").has("kind")).toBe(true);
    expect(entries.find(e => e.id === "commit")?.parameters.properties?.all.description).toContain("NOT this session");
  });

  it("accepts --if-match on map add, which the Desktop engine sends for a compare-and-set Map edit", () => {
    expect(catalogFlagError("map", ["add", "m.map.md", "thread:x_1"], { "if-match": "abc" })).toBeUndefined();
    expect(catalogFlagError("map", ["add", "m.map.md", "thread:x_1"], { "if-mach": "abc" })).toContain("--if-mach");
  });
});
