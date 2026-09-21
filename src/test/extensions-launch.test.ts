import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchOverrides, resolveLaunch } from "../extensions/resolve.js";
import { approve, isApproved, readApprovals, revoke, writeApprovals } from "../extensions/approvals.js";
import { inspectExtension } from "../extensions/inspect.js";
import { claudeLaunchSet, describeRefusals, piLaunchSet, runRuntime } from "../extensions/runtimes.js";
import { buildPiArgs } from "../pi/local-agent.js";
import { buildClaudeArgs } from "../claude/local-agent.js";

describe("parseLaunchOverrides — the conversation's own choice", () => {
  it("adds with + or bare, removes with -", () => {
    expect(parseLaunchOverrides("+npm:a, -git:b@v1 ,c")).toEqual({ add: ["npm:a", "c"], remove: ["git:b@v1"] });
    expect(parseLaunchOverrides(undefined)).toEqual({ add: [], remove: [] });
    expect(parseLaunchOverrides(" , + ,-")).toEqual({ add: [], remove: [] });
  });
});

describe("resolveLaunch — bundled ∪ approved declarations ∪ additions, nothing else", () => {
  const yes = () => true;
  const none = { add: [], remove: [] };

  it("no declaration, no override → nothing beyond bundled", () => {
    expect(resolveLaunch({ bundled: ["core"], declared: [], approved: yes, overrides: none })).toEqual({ loaded: [], refused: [] });
  });

  it("an approved declaration loads, in declaration order", () => {
    const r = resolveLaunch({ bundled: [], declared: ["b", "a"], approved: yes, overrides: none });
    expect(r.loaded).toEqual(["b", "a"]);
  });

  it("an unapproved declaration is refused with the source named, and the rest still loads", () => {
    const r = resolveLaunch({ bundled: [], declared: ["ok", "sus"], approved: (s) => s === "ok", overrides: none });
    expect(r).toEqual({ loaded: ["ok"], refused: [{ source: "sus", reason: "unapproved" }] });
  });

  it("a conversation removes a declared one and adds one of its own without approval", () => {
    const r = resolveLaunch({ bundled: [], declared: ["a", "b"], approved: yes, overrides: { add: ["c"], remove: ["b"] } });
    expect(r.loaded).toEqual(["a", "c"]);
  });

  it("a declaration of a bundled id is a no-op, never a duplicate", () => {
    const r = resolveLaunch({ bundled: ["core"], declared: ["core", "x"], approved: yes, overrides: { add: ["core", "x"], remove: [] } });
    expect(r.loaded).toEqual(["x"]);
  });

  it("removal wins over addition of the same id", () => {
    const r = resolveLaunch({ bundled: [], declared: [], approved: yes, overrides: { add: ["x"], remove: ["x"] } });
    expect(r.loaded).toEqual([]);
  });
});

describe("approvals — per (runtime, agent root, source verbatim)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "is-approvals-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips through the file and keys on the exact source", () => {
    const file = join(dir, "a.json");
    const entry = { runtime: "pi" as const, agentRoot: "/agents/x", source: "git:h/r@v1" };
    writeApprovals(approve([], entry, new Date("2026-09-21T00:00:00Z")), file);
    const back = readApprovals(file);
    expect(back).toEqual([{ ...entry, approvedAt: "2026-09-21T00:00:00.000Z" }]);
    expect(isApproved(back, "pi", "/agents/x", "git:h/r@v1")).toBe(true);
    // A moved ref is a new source; another agent root is another approval.
    expect(isApproved(back, "pi", "/agents/x", "git:h/r@v2")).toBe(false);
    expect(isApproved(back, "pi", "/agents/y", "git:h/r@v1")).toBe(false);
    expect(isApproved(back, "claude", "/agents/x", "git:h/r@v1")).toBe(false);
  });

  it("approve is idempotent and revoke removes exactly one", () => {
    const a = { runtime: "claude" as const, agentRoot: "/a", source: "x@m" };
    const b = { runtime: "claude" as const, agentRoot: "/a", source: "y@m" };
    const list = approve(approve(approve([], a), a), b);
    expect(list).toHaveLength(2);
    expect(revoke(list, a).map((e) => e.source)).toEqual(["y@m"]);
  });

  it("a corrupt file approves nothing", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    expect(readApprovals(file)).toEqual([]);
  });
});

describe("inspectExtension — what a directory brings, no spawn", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "is-inspect-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads a pi manifest with a skills dir", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@x/pkg", version: "1.0.0", description: "d", pi: { extensions: ["./src/index.ts"], skills: ["./skills"] },
    }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    mkdirSync(join(dir, "skills", "one"), { recursive: true });
    writeFileSync(join(dir, "skills", "one", "SKILL.md"), "");
    writeFileSync(join(dir, "skills", "flat.md"), "");
    expect(inspectExtension("pi", dir)).toEqual({
      runtime: "pi", name: "@x/pkg", description: "d", version: "1.0.0",
      components: { extensions: 1, skills: 2, prompts: 0, themes: 0 },
    });
  });

  it("reads a Claude/Codex plugin by its convention dirs", () => {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", version: "0.3.45", description: "d" }));
    mkdirSync(join(dir, "skills", "a"), { recursive: true });
    writeFileSync(join(dir, "skills", "a", "SKILL.md"), "");
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [], PreToolUse: [] } }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { core: {} } }));
    expect(inspectExtension("codex", dir)).toEqual({
      runtime: "codex", name: "p", description: "d", version: "0.3.45",
      components: { skills: 1, agents: 0, commands: 0, hooks: 2, mcpServers: 1 },
    });
  });
});

// --- Launch sets against a fake binary -------------------------------------
//
// The fake `pi` records every argv to FAKE_LOG, answers `list` with FAKE_LIST,
// and makes `install` append a project row — enough to prove which spawns a
// turn makes and in what order, with no real pi.

const FAKE_PI = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  list) cat "$FAKE_LIST" ;;
  install) printf '  %s\\n    %s\\n' "$2" "$FAKE_INSTALL_DIR" >> "$FAKE_LIST" ;;
esac
`;

const FAKE_CLAUDE = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$2" in
  list) cat "$FAKE_LIST" ;;
  install) node -e '
    const fs=require("fs"); const f=process.env.FAKE_LIST; const d=JSON.parse(fs.readFileSync(f,"utf8"));
    d.installed.push({id:process.argv[1],version:"1.0.0",scope:"project",enabled:true,installPath:process.env.FAKE_INSTALL_DIR});
    fs.writeFileSync(f, JSON.stringify(d));' "$3" ;;
esac
`;

function pkgDir(root: string, name: string, withSkills = false): string {
  const dir = join(root, name.replace(/[@/]/g, "_"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  if (withSkills) mkdirSync(join(dir, "skills"));
  return dir;
}

describe("piLaunchSet — from declaration and overrides to --extension paths", () => {
  let root: string;
  let agent: string;
  let bin: string;
  let log: string;
  let list: string;
  let env: NodeJS.ProcessEnv;
  let bundled: string[];
  const home = process.env.HOME;
  const spawns = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "is-pilaunch-"));
    agent = join(root, "agent");
    mkdirSync(join(agent, ".pi"), { recursive: true });
    bin = join(root, "pi");
    writeFileSync(bin, FAKE_PI);
    chmodSync(bin, 0o755);
    log = join(root, "argv.log");
    list = join(root, "list.txt");
    bundled = [pkgDir(root, "@ideaspaces/pi-is-space"), pkgDir(root, "@ideaspaces/pi-local-context")];
    const libWeb = pkgDir(root, "pi-web-access", true);
    const libDup = pkgDir(join(root, "lib"), "@ideaspaces/pi-is-space");
    writeFileSync(list, `User packages:\n  npm:pi-web-access\n    ${libWeb}\n  ../pi-is-space\n    ${libDup}\n\nProject packages:\n`);
    // Approvals live under $HOME/.ideaspaces — point HOME at the sandbox.
    env = { ...process.env, HOME: root, FAKE_LOG: log, FAKE_LIST: list, FAKE_INSTALL_DIR: pkgDir(root, "installed-repo", true) };
    process.env.HOME = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.HOME = home;
  });

  const run = (overrides?: string) => piLaunchSet({ spawn: { bin, env }, agentRoot: agent, bundledPaths: bundled, overrides });
  const declare = (...sources: string[]) => writeFileSync(join(agent, ".pi", "settings.json"), JSON.stringify({ packages: sources }));

  it("no declaration and no override → no spawn at all (today's turn)", () => {
    expect(run()).toEqual({ extensionPaths: [], skillPaths: [], refused: [], loaded: [] });
    expect(spawns()).toEqual([]);
  });

  it("an unapproved declaration is refused before any spawn", () => {
    declare("git:github.com/u/r@v1");
    const set = run();
    expect(set.refused).toEqual([{ source: "git:github.com/u/r@v1", reason: "unapproved" }]);
    expect(set.extensionPaths).toEqual([]);
    expect(spawns()).toEqual([]);
    expect(describeRefusals(set.refused, "pi", agent)[0]).toContain(`extensions approve git:github.com/u/r@v1 --runtime pi --agent ${agent}`);
  });

  it("an approved declaration that is not installed is installed into the agent repo, then loaded with its skills", () => {
    declare("git:github.com/u/r@v1");
    writeApprovals(approve([], { runtime: "pi", agentRoot: agent, source: "git:github.com/u/r@v1" }));
    const set = run();
    expect(spawns()).toEqual(["list --approve", "install git:github.com/u/r@v1 -l --approve", "list --approve"]);
    expect(set.extensionPaths).toEqual([env.FAKE_INSTALL_DIR]);
    expect(set.skillPaths).toEqual([join(env.FAKE_INSTALL_DIR!, "skills")]);
    expect(set.loaded).toEqual(["git:github.com/u/r@v1"]);
  });

  it("a conversation addition comes from the library and needs no approval; a removal drops a declaration", () => {
    declare("git:github.com/u/r@v1");
    writeApprovals(approve([], { runtime: "pi", agentRoot: agent, source: "git:github.com/u/r@v1" }));
    const set = run("+npm:pi-web-access,-git:github.com/u/r@v1");
    expect(spawns()).toEqual(["list --approve"]);
    expect(set.extensionPaths).toEqual([join(root, "pi-web-access")]);
    expect(set.loaded).toEqual(["npm:pi-web-access"]);
  });

  it("an addition that is not in the library is refused, not installed", () => {
    const set = run("+npm:not-there");
    expect(set.refused).toEqual([{ source: "npm:not-there", reason: "not-installed" }]);
    expect(spawns()).toEqual(["list --approve"]);
  });

  it("a library copy of a bundled extension loads once — never a duplicate tool set", () => {
    const set = run("+../pi-is-space");
    expect(set.extensionPaths).toEqual([]);
    expect(set.loaded).toEqual([]);
    expect(set.refused).toEqual([]);
  });

  it("a broken declaration file is an error naming the file, not a silent empty set", () => {
    writeFileSync(join(agent, ".pi", "settings.json"), "{oops");
    expect(() => run()).toThrow(/\.pi\/settings\.json/);
  });
});

describe("claudeLaunchSet — from declaration and overrides to --settings", () => {
  let root: string;
  let agent: string;
  let bin: string;
  let log: string;
  let list: string;
  let env: NodeJS.ProcessEnv;
  const home = process.env.HOME;
  const spawns = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "is-claudelaunch-"));
    agent = join(root, "agent");
    mkdirSync(join(agent, ".claude"), { recursive: true });
    bin = join(root, "claude");
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    log = join(root, "argv.log");
    list = join(root, "list.json");
    writeFileSync(list, JSON.stringify({
      installed: [
        { id: "ideaspaces@ideaspaces-xyz", version: "0.3.45", scope: "user", enabled: true, installPath: "/p/is" },
        { id: "ralph-loop@claude-plugins-official", version: "1.0.0", scope: "user", enabled: true, installPath: "/p/rl" },
        { id: "rust-analyzer-lsp@claude-plugins-official", version: "1.0.0", scope: "user", enabled: true, installPath: "/p/ra" },
      ],
      available: [],
    }));
    env = { ...process.env, HOME: root, FAKE_LOG: log, FAKE_LIST: list, FAKE_INSTALL_DIR: "/p/new" };
    process.env.HOME = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.HOME = home;
  });

  const run = (overrides?: string) => claudeLaunchSet({ spawn: { bin, env }, agentRoot: agent, overrides });
  const declare = (...ids: string[]) =>
    writeFileSync(join(agent, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])) }));

  it("no declaration and no override → no --settings and no spawn", () => {
    expect(run()).toEqual({ settings: null, refused: [], loaded: [] });
    expect(spawns()).toEqual([]);
  });

  it("an approved declaration fixes the exact set: it and the connector on, everything else off", () => {
    declare("ralph-loop@claude-plugins-official");
    writeApprovals(approve([], { runtime: "claude", agentRoot: agent, source: "ralph-loop@claude-plugins-official" }));
    const set = run();
    expect(spawns()).toEqual(["plugin list --available --json"]);
    expect(JSON.parse(set.settings!)).toEqual({
      enabledPlugins: {
        "ideaspaces@ideaspaces-xyz": true,
        "ralph-loop@claude-plugins-official": true,
        "rust-analyzer-lsp@claude-plugins-official": false,
      },
    });
    expect(set.loaded).toEqual(["ralph-loop@claude-plugins-official"]);
  });

  it("a conversation removal of an unapproved declaration still turns everything else off", () => {
    declare("ralph-loop@claude-plugins-official");
    const set = run("-ralph-loop@claude-plugins-official");
    expect(set.refused).toEqual([]);
    expect(JSON.parse(set.settings!).enabledPlugins["ralph-loop@claude-plugins-official"]).toBe(false);
    expect(JSON.parse(set.settings!).enabledPlugins["ideaspaces@ideaspaces-xyz"]).toBe(true);
  });

  it("an approved declaration that is not installed is installed at project scope in the agent repo first", () => {
    declare("new@m");
    writeApprovals(approve([], { runtime: "claude", agentRoot: agent, source: "new@m" }));
    const set = run();
    expect(spawns()).toEqual([
      "plugin list --available --json",
      "plugin install new@m --scope project --json -y",
      "plugin list --available --json",
    ]);
    expect(JSON.parse(set.settings!).enabledPlugins["new@m"]).toBe(true);
  });

  it("the connector cannot be removed by a conversation", () => {
    const set = run("-ideaspaces@ideaspaces-xyz,+ralph-loop@claude-plugins-official");
    expect(JSON.parse(set.settings!).enabledPlugins["ideaspaces@ideaspaces-xyz"]).toBe(true);
  });
});

describe("argv — the launch set reaches the runtime", () => {
  it("pi: extra paths ride after the bundled ones, still under --no-extensions", () => {
    const args = buildPiArgs({
      repoPath: "/a", message: "hi", conversationId: "c", sessionDir: "/a/.pi/sessions",
      extensionPaths: ["/bundled/pi-is-space", "/agent/.pi/git/h/r"], skillPaths: ["/agent/.pi/git/h/r/skills"],
    });
    expect(args).toContain("--no-extensions");
    expect(args.join(" ")).toContain("--extension /bundled/pi-is-space --extension /agent/.pi/git/h/r --skill /agent/.pi/git/h/r/skills");
  });

  it("claude: --settings carries the map; absent, nothing is passed", () => {
    const base = { repoPath: "/a", message: "hi", conversationId: "00000000-0000-4000-8000-000000000000", sessionExists: true };
    expect(buildClaudeArgs(base)).not.toContain("--settings");
    const args = buildClaudeArgs({ ...base, launchSettings: '{"enabledPlugins":{"a@m":true}}' });
    expect(args.slice(args.indexOf("--settings"), args.indexOf("--settings") + 2)).toEqual(["--settings", '{"enabledPlugins":{"a@m":true}}']);
  });
});

describe("runRuntime", () => {
  it("names a missing binary in one sentence", () => {
    expect(() => runRuntime({ bin: "/nope/definitely-not-a-binary" }, ["list"])).toThrow(/not installed or not on PATH/);
  });
});
