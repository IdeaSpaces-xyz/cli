import { describe, it, expect } from "vitest";
import { deriveClaudeStatus, parseClaudeAuthReport } from "../claude/claude-status.js";
import type { ClaudeBinary } from "../claude/claude-status.js";
import { claudeModelList, getClaudeDefaults } from "../claude/claude-models.js";

const present: ClaudeBinary = { present: true, path: "claude", version: "2.1.273" };
const absent: ClaudeBinary = { present: false, path: "/nope/claude", version: null };

// Verbatim from `claude auth status --json` on Claude Code 2.1.273 (2026-09-16).
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  projectsDirectory: "/home/u/.claude/projects",
  configDirectory: "/home/u/.claude",
  email: "u@example.com",
  orgId: "00000000-0000-0000-0000-000000000000",
  orgName: "u's Organization",
  subscriptionType: "max",
});
// Signed out — Claude Code exits 1 but still prints the report.
const SIGNED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  projectsDirectory: "/tmp/x/projects",
  configDirectory: "/tmp/x",
});
// An ANTHROPIC_API_KEY in the child env, with `--claude-auth api-key` letting it through.
const API_KEY = JSON.stringify({
  loggedIn: true,
  authMethod: "api_key",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  projectsDirectory: "/tmp/x/projects",
  configDirectory: "/tmp/x",
  apiKeySource: "ANTHROPIC_API_KEY",
});

describe("deriveClaudeStatus — the three states the connector card distinguishes", () => {
  it("binary absent: not ready, login unknown, detail names the path", () => {
    const s = deriveClaudeStatus({ binary: absent, authStdout: null, auth: "login" });
    expect(s.ready).toBe(false);
    expect(s.binary.present).toBe(false);
    expect(s.login.loggedIn).toBeNull();
    expect(s.login.detail).toContain("/nope/claude");
  });

  it("binary present, signed out: not ready, loggedIn false, method none", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: SIGNED_OUT, auth: "login" });
    expect(s.ready).toBe(false);
    expect(s.login).toEqual({ loggedIn: false, method: "none", subscription: null, detail: null });
  });

  it("signed in through claude.ai: ready, with method and plan hint", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: SIGNED_IN, auth: "login" });
    expect(s.ready).toBe(true);
    expect(s.login).toEqual({ loggedIn: true, method: "claude.ai", subscription: "max", detail: null });
    expect(s.auth).toBe("login");
  });

  it("never carries account identifiers or credentials from the report", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: SIGNED_IN, auth: "login" });
    const flat = JSON.stringify(s);
    expect(flat).not.toContain("u@example.com");
    expect(flat).not.toContain("orgId");
    expect(flat).not.toContain("configDirectory");
  });

  it("api-key auth: an API key counts as signed in, and the record says which path was probed", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: API_KEY, auth: "api-key" });
    expect(s.ready).toBe(true);
    expect(s.login.method).toBe("api_key");
    expect(s.auth).toBe("api-key");
  });

  it("the auth probe could not run at all: present, login unknown, detail says so", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: null, auth: "login" });
    expect(s.ready).toBe(false);
    expect(s.login.loggedIn).toBeNull();
    expect(s.login.detail).toContain("could not run");
    expect(s.login.detail).not.toContain("newer Claude Code");
  });

  it("an older Claude Code without `auth status`: present but login unknown, not ready", () => {
    // Pre-`auth` binaries print `error: unknown command 'auth'` on stderr; stdout is empty.
    const s = deriveClaudeStatus({ binary: present, authStdout: "", auth: "login" });
    expect(s.ready).toBe(false);
    expect(s.binary.present).toBe(true);
    expect(s.login.loggedIn).toBeNull();
    expect(s.login.detail).toContain("newer Claude Code");
  });

  it("lists the models the binary reported, and compaction capabilities from its version", () => {
    const models = claudeModelList([{ ref: "opus", model: "claude-opus-9-9" }, { ref: "haiku", model: "claude-haiku-9-9" }],
      getClaudeDefaults(present.version));
    const s = deriveClaudeStatus({ binary: present, authStdout: SIGNED_IN, auth: "login", models });
    expect(s.models.map((m) => [m.ref, m.id])).toEqual([["opus", "claude-opus-9-9"], ["haiku", "claude-haiku-9-9"]]);
    expect(s.models.find((m) => m.ref === "haiku")?.contextWindow).toBe(200_000);
    expect(s.modelsDetail).toBeNull();
    expect(s.capabilities.compact.supported).toBe(true);
    expect(s.capabilities.compact.autocompact.supported).toBe(true);
    expect(s.capabilities.compact.autocompact.minTokens).toBe(100_000);
    expect(s.capabilities.compact.autocompact.maxTokens).toBe(1_000_000);
  });
});

describe("deriveClaudeStatus — models are only what the binary reported", () => {
  it("not asked, or absent: no models, and the reason", () => {
    const notAsked = deriveClaudeStatus({ binary: present, authStdout: SIGNED_IN, auth: "login" });
    expect(notAsked.models).toEqual([]);
    expect(notAsked.modelsDetail).toBe("Claude Code was not asked for its models");
    const gone = deriveClaudeStatus({ binary: absent, authStdout: null, auth: "login",
      models: claudeModelList([{ ref: "opus", model: "claude-opus-9-9" }], getClaudeDefaults(null)) });
    expect(gone.models).toEqual([]);
    expect(gone.modelsDetail).toContain("/nope/claude");
  });

  it("signed out still lists what the binary resolved, so a client keeps a saved model's route", () => {
    const s = deriveClaudeStatus({ binary: present, authStdout: SIGNED_OUT, auth: "login",
      models: claudeModelList([{ ref: "fable", model: "claude-fable-9-9" }], getClaudeDefaults(present.version)) });
    expect(s.ready).toBe(false);
    expect(s.models.map((m) => m.id)).toEqual(["claude-fable-9-9"]);
  });
});

describe("parseClaudeAuthReport", () => {
  it("accepts the report whatever the exit code implied", () => {
    expect(parseClaudeAuthReport(SIGNED_OUT)?.loggedIn).toBe(false);
    expect(parseClaudeAuthReport(SIGNED_IN)?.loggedIn).toBe(true);
  });

  it("rejects prose, empty output, and JSON without a boolean loggedIn", () => {
    expect(parseClaudeAuthReport("")).toBeNull();
    expect(parseClaudeAuthReport("error: unknown command 'auth'")).toBeNull();
    expect(parseClaudeAuthReport("{}")).toBeNull();
    expect(parseClaudeAuthReport(JSON.stringify({ loggedIn: "yes" }))).toBeNull();
    expect(parseClaudeAuthReport("null")).toBeNull();
  });
});
