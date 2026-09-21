import { describe, it, expect } from "vitest";
import {
  parsePiList,
  parsePiPackagesField,
  piInstallArgs,
  piRemoveArgs,
  piSourceVersion,
  piUpdateArgs,
} from "../extensions/pi-packages.js";
import {
  claudeInstallArgs,
  claudeLaunchSettings,
  claudeMarketplaceOf,
  parseClaudeEnabledPlugins,
  parseClaudeMarketplaceList,
  parseClaudePluginList,
} from "../extensions/claude-plugins.js";
import { codexLaunchOverrides, parseCodexMarketplaceList, parseCodexPluginList } from "../extensions/codex-plugins.js";

// Verbatim from `pi list` on pi 0.86.1 (2026-09-21), paths shortened. Two
// scopes, a relative-path source, and a filtered entry.
const PI_LIST = `User packages:
  npm:@ogulcancelik/pi-web-browse
    /Users/u/.pi/agent/npm/node_modules/@ogulcancelik/pi-web-browse
  ../../projects/pi-is-space
    /Users/u/projects/pi-is-space
  npm:pi-web-access (filtered)
    /Users/u/.pi/agent/npm/node_modules/pi-web-access

Project packages:
  git:github.com/user/repo@v1
    /agents/x/.pi/git/github.com/user/repo
`;

describe("parsePiList — pi's text listing, the one place that knows its layout", () => {
  it("reads user and project rows with their install paths", () => {
    const rows = parsePiList(PI_LIST, "/agents/x");
    expect(rows.map((r) => [r.source, r.scope, r.installPath])).toEqual([
      ["npm:@ogulcancelik/pi-web-browse", "user", "/Users/u/.pi/agent/npm/node_modules/@ogulcancelik/pi-web-browse"],
      ["../../projects/pi-is-space", "user", "/Users/u/projects/pi-is-space"],
      ["npm:pi-web-access", "user", "/Users/u/.pi/agent/npm/node_modules/pi-web-access"],
      ["git:github.com/user/repo@v1", "agent", "/agents/x/.pi/git/github.com/user/repo"],
    ]);
  });

  it("strips the (filtered) marker and keeps the source as the id", () => {
    const row = parsePiList(PI_LIST, null)[2];
    expect(row.id).toBe("npm:pi-web-access");
    expect(row.runtime).toBe("pi");
  });

  it("names the agent root only on project rows", () => {
    const rows = parsePiList(PI_LIST, "/agents/x");
    expect(rows[0].declaredBy).toBeNull();
    expect(rows[3].declaredBy).toBe("/agents/x");
  });

  it("reads the empty listing and a source with no path", () => {
    expect(parsePiList("No packages installed.\n", null)).toEqual([]);
    const rows = parsePiList("User packages:\n  npm:gone\n", null);
    expect(rows).toHaveLength(1);
    expect(rows[0].installPath).toBeNull();
  });
});

describe("piSourceVersion — the pinned ref a source names", () => {
  it.each([
    ["npm:pkg@1.2.3", "1.2.3"],
    ["npm:@scope/pkg@1.2.3", "1.2.3"],
    ["npm:@scope/pkg", null],
    ["git:github.com/user/repo@v1", "v1"],
    ["https://github.com/user/repo", null],
    ["../local/path", null],
  ])("%s → %s", (source, version) => {
    expect(piSourceVersion(source)).toBe(version);
  });
});

describe("pi argv", () => {
  it("installs into the agent repo with -l and --approve; the library plain", () => {
    expect(piInstallArgs("npm:x", "agent")).toEqual(["install", "npm:x", "-l", "--approve"]);
    expect(piInstallArgs("npm:x", "user")).toEqual(["install", "npm:x"]);
    expect(piRemoveArgs("npm:x", "agent")).toEqual(["remove", "npm:x", "-l", "--approve"]);
    expect(piUpdateArgs()).toEqual(["update", "--extensions"]);
    expect(piUpdateArgs("npm:x")).toEqual(["update", "npm:x"]);
  });
});

describe("parsePiPackagesField — the agent repo's .pi/settings.json", () => {
  it("accepts string and object sources, drops the rest", () => {
    expect(
      parsePiPackagesField({
        packages: ["npm:a", { source: "git:github.com/u/r@v1", extensions: ["x/*.ts"] }, 42, { nope: true }, " "],
      }),
    ).toEqual(["npm:a", "git:github.com/u/r@v1"]);
    expect(parsePiPackagesField({})).toEqual([]);
    expect(parsePiPackagesField(null)).toEqual([]);
  });
});

// Verbatim from `claude plugin list --available --json` on 2.1.278 (2026-09-21), trimmed.
const CLAUDE_LIST = JSON.stringify({
  installed: [
    {
      id: "ideaspaces@ideaspaces-xyz",
      version: "0.3.45",
      scope: "user",
      enabled: true,
      installPath: "/Users/u/.claude/plugins/cache/ideaspaces-xyz/ideaspaces/0.3.45",
      installedAt: "2026-05-08T06:26:28.551Z",
      lastUpdated: "2026-09-17T17:45:50.758Z",
      mcpServers: { core: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"] } },
    },
    {
      id: "ralph-loop@claude-plugins-official",
      version: "1.0.0",
      scope: "project",
      enabled: false,
      installPath: "/Users/u/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0",
    },
  ],
  available: [
    {
      pluginId: "42crunch-api-security-testing@claude-plugins-official",
      name: "42crunch-api-security-testing",
      description: "Automate API security directly in Claude Code with 42Crunch",
      marketplaceName: "claude-plugins-official",
      source: { source: "git-subdir", url: "https://github.com/42Crunch-AI/claude-plugins.git" },
      installCount: "3211",
    },
  ],
});

describe("parseClaudePluginList", () => {
  it("maps installed rows, with project/local scope as the agent tier", () => {
    const { installed } = parseClaudePluginList(CLAUDE_LIST, "/agents/x");
    expect(installed).toEqual([
      {
        runtime: "claude",
        id: "ideaspaces@ideaspaces-xyz",
        source: "ideaspaces-xyz",
        version: "0.3.45",
        scope: "user",
        enabled: true,
        installPath: "/Users/u/.claude/plugins/cache/ideaspaces-xyz/ideaspaces/0.3.45",
        declaredBy: null,
      },
      {
        runtime: "claude",
        id: "ralph-loop@claude-plugins-official",
        source: "claude-plugins-official",
        version: "1.0.0",
        scope: "agent",
        enabled: false,
        installPath: "/Users/u/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0",
        declaredBy: "/agents/x",
      },
    ]);
  });

  it("maps the catalog", () => {
    const { available } = parseClaudePluginList(CLAUDE_LIST, null);
    expect(available).toEqual([
      {
        runtime: "claude",
        id: "42crunch-api-security-testing@claude-plugins-official",
        name: "42crunch-api-security-testing",
        description: "Automate API security directly in Claude Code with 42Crunch",
        marketplace: "claude-plugins-official",
      },
    ]);
  });

  it("accepts the bare array `claude plugin list --json` prints without --available", () => {
    const { installed, available } = parseClaudePluginList(JSON.stringify([{ id: "a@m", scope: "user" }]), null);
    expect(installed.map((r) => r.id)).toEqual(["a@m"]);
    expect(available).toEqual([]);
  });

  it("rejects non-JSON with the command named", () => {
    expect(() => parseClaudePluginList("error: unknown option", null)).toThrow(/claude plugin list/);
  });
});

describe("claude marketplaces and argv", () => {
  it("reads github, git, and path sources", () => {
    const out = parseClaudeMarketplaceList(
      JSON.stringify([
        { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official", installLocation: "/x" },
        { name: "ideaspaces-xyz", source: "git", url: "git@github.com:IdeaSpaces-xyz/claude-code-plugin.git", installLocation: "/y" },
        { name: "local", source: "local", path: "/tmp/mp" },
      ]),
    );
    expect(out.map((m) => [m.name, m.source])).toEqual([
      ["claude-plugins-official", "anthropics/claude-plugins-official"],
      ["ideaspaces-xyz", "git@github.com:IdeaSpaces-xyz/claude-code-plugin.git"],
      ["local", "/tmp/mp"],
    ]);
  });

  it("installs headlessly at the mapped scope", () => {
    expect(claudeInstallArgs("a@m", "agent")).toEqual(["plugin", "install", "a@m", "--scope", "project", "--json", "-y"]);
    expect(claudeInstallArgs("a@m", "user")).toEqual(["plugin", "install", "a@m", "--scope", "user", "--json", "-y"]);
    expect(claudeMarketplaceOf("a@m")).toBe("m");
    expect(claudeMarketplaceOf("bare")).toBe("");
  });

  it("reads the agent repo's enabledPlugins, true entries only", () => {
    expect(parseClaudeEnabledPlugins({ enabledPlugins: { "a@m": true, "b@m": false, "c@m": "yes" } })).toEqual(["a@m"]);
    expect(parseClaudeEnabledPlugins({ permissions: {} })).toEqual([]);
  });
});

describe("claudeLaunchSettings — the exact set, as --settings JSON", () => {
  it("names every installed plugin, true for the loaded ones, false for the rest", () => {
    const json = claudeLaunchSettings(["a@m", "b@m", "c@m"], ["b@m"]);
    expect(JSON.parse(json)).toEqual({ enabledPlugins: { "a@m": false, "b@m": true, "c@m": false } });
  });

  it("still enables a loaded id that the installed list did not carry", () => {
    expect(JSON.parse(claudeLaunchSettings([], ["x@m"]))).toEqual({ enabledPlugins: { "x@m": true } });
  });
});

// Verbatim from `codex plugin list --json` on 0.145.0 (2026-09-21), trimmed.
const CODEX_LIST = JSON.stringify({
  installed: [
    {
      pluginId: "ideaspaces@ideaspaces-xyz",
      name: "ideaspaces",
      marketplaceName: "ideaspaces-xyz",
      version: "0.3.42",
      installed: true,
      enabled: true,
      source: { source: "local", path: "/Users/u/.codex/.tmp/marketplaces/ideaspaces-xyz" },
      marketplaceSource: { sourceType: "git", source: "https://github.com/IdeaSpaces-xyz/claude-code-plugin.git" },
      installPolicy: "AVAILABLE",
      authPolicy: "ON_INSTALL",
    },
  ],
  available: [],
});

describe("codex", () => {
  it("maps installed rows at user scope with the marketplace as source", () => {
    const { installed, available } = parseCodexPluginList(CODEX_LIST);
    expect(installed).toEqual([
      {
        runtime: "codex",
        id: "ideaspaces@ideaspaces-xyz",
        source: "ideaspaces-xyz",
        version: "0.3.42",
        scope: "user",
        enabled: true,
        installPath: "/Users/u/.codex/.tmp/marketplaces/ideaspaces-xyz",
        declaredBy: null,
      },
    ]);
    expect(available).toEqual([]);
  });

  it("reads marketplaces from their source, falling back to the root", () => {
    const out = parseCodexMarketplaceList(
      JSON.stringify({
        marketplaces: [
          { name: "ideaspaces-xyz", root: "/r", marketplaceSource: { sourceType: "git", source: "https://github.com/IdeaSpaces-xyz/claude-code-plugin.git" } },
          { name: "openai-bundled", root: "/b" },
        ],
      }),
    );
    expect(out.map((m) => [m.name, m.source])).toEqual([
      ["ideaspaces-xyz", "https://github.com/IdeaSpaces-xyz/claude-code-plugin.git"],
      ["openai-bundled", "/b"],
    ]);
  });

  it("overrides enablement per launch with -c", () => {
    expect(codexLaunchOverrides({ "a@m": true, "b@m": false })).toEqual([
      "-c", 'plugins."a@m".enabled=true',
      "-c", 'plugins."b@m".enabled=false',
    ]);
  });
});
