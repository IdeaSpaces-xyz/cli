import { describe, expect, it } from "vitest";
import { classifyInstall, sameGlobalRoot, updateAdvice, type InstallKind } from "../install-kind.js";

function kind(path: string, options: { host?: boolean; files?: string[] } = {}): InstallKind {
  return classifyInstall(path, {
    host: options.host ?? false,
    exists: (candidate) => (options.files ?? []).includes(candidate),
  }).kind;
}

const CLI = "node_modules/@ideaspaces/cli/bundle/ideaspaces.js";

describe("classifyInstall", () => {
  it.each([
    ["Homebrew Node", `/opt/homebrew/lib/${CLI}`],
    ["nvm", `/Users/a/.nvm/versions/node/v22.1.0/lib/${CLI}`],
    ["system Node", `/usr/local/lib/${CLI}`],
    ["Volta", `/Users/a/.volta/tools/image/packages/@ideaspaces/cli/lib/${CLI}`],
    ["Windows", `C:\\Users\\a\\AppData\\Roaming\\npm\\${CLI.replaceAll("/", "\\")}`],
  ])("reads a global npm install: %s", (_name, path) => {
    expect(kind(path)).toBe("npm");
  });

  it("reads the other global package managers", () => {
    expect(kind(`/Users/a/.bun/install/global/${CLI}`, { files: ["/Users/a/.bun/install/global/package.json"] })).toBe("bun");
    expect(kind(`/Users/a/.config/yarn/global/${CLI}`, { files: ["/Users/a/.config/yarn/global/package.json"] })).toBe("yarn");
    expect(kind(`/Users/a/Library/pnpm/global/5/.pnpm/@ideaspaces+cli@0.6.0/${CLI}`)).toBe("pnpm");
  });

  it("reads an npx cache copy", () => {
    expect(kind(`/Users/a/.npm/_npx/f7a1/${CLI}`, { files: ["/Users/a/.npm/_npx/f7a1/package.json"] })).toBe("npx");
  });

  it("the app wins, by host mode or by its bundled path", () => {
    expect(kind(`/opt/homebrew/lib/${CLI}`, { host: true })).toBe("app");
    expect(kind("/Applications/Idea Explorer.app/Contents/Resources/resources/cli/ideaspaces.js")).toBe("app");
    expect(kind("C:\\Program Files\\Idea Explorer\\resources\\cli\\ideaspaces.js")).toBe("app");
  });

  it("finds the plugin by its manifest, wherever its config directory lives", () => {
    const root = "/Users/a/.claude/plugins/cache/ideaspaces-xyz/ideaspaces/0.7.0";
    expect(kind(`${root}/cli/bundle/ideaspaces.js`, { files: [`${root}/.claude-plugin/plugin.json`] })).toBe("plugin");
    expect(kind("/elsewhere/cli/bundle/ideaspaces.js", { files: ["/elsewhere/.claude-plugin/plugin.json"] })).toBe("plugin");
  });

  it("a copy nested in Pi's package is Pi's, even inside a global folder", () => {
    expect(kind(`/Users/a/.pi/agent/git/github.com/IdeaSpaces-xyz/pi-is-space/${CLI}`)).toBe("pi");
    expect(kind(`/usr/local/lib/node_modules/@ideaspaces/pi-is-space/${CLI}`)).toBe("pi");
  });

  it("a project's copy is a dependency, not something to install globally", () => {
    expect(kind(`/work/app/${CLI}`, { files: ["/work/app/package.json"] })).toBe("dependency");
    expect(kind(`/work/app/node_modules/.pnpm/@ideaspaces+cli@0.6.0/${CLI}`)).toBe("dependency");
  });

  it("a checkout, npm-linked or not, is source", () => {
    expect(kind("/code/cli/bundle/ideaspaces.js", { files: ["/code/cli/src/main.ts"] })).toBe("source");
    expect(kind("/code/cli/dist/main.js", { files: ["/code/cli/src/main.ts"] })).toBe("source");
  });

  it("what it cannot place is unknown, never a guess", () => {
    expect(kind("/tmp/ideaspaces.js")).toBe("unknown");
    expect(kind("/cli/bundle/ideaspaces.js")).toBe("unknown");
    expect(kind("/$bunfs/root/ideaspaces")).toBe("unknown");
  });
});

describe("updateAdvice", () => {
  const advice = (k: InstallKind, owner?: string) => updateAdvice({ kind: k, path: "/x/ideaspaces.js", owner });

  it("gives the exact command for each install", () => {
    expect(advice("npm").command).toBe("ideaspaces upgrade");
    expect(advice("pnpm").command).toBe("pnpm add -g @ideaspaces/cli@latest");
    expect(advice("yarn").command).toBe("yarn global add @ideaspaces/cli@latest");
    expect(advice("bun").command).toBe("bun add -g @ideaspaces/cli@latest");
    expect(advice("npx").command).toBe("npx @ideaspaces/cli@latest");
    expect(advice("plugin").command).toBe("claude plugin update ideaspaces@ideaspaces-xyz");
    expect(advice("pi").command).toBe("pi update --extensions");
  });

  it("says where to go when no command fits", () => {
    expect(advice("app").text).toContain("Update the app");
    expect(advice("dependency", "/work/app").text).toContain("/work/app");
    expect(advice("unknown").text).toContain("/x/ideaspaces.js");
  });
});

describe("sameGlobalRoot", () => {
  it("matches npm's root to the copy's owner, and only that", () => {
    expect(sameGlobalRoot("/opt/homebrew/lib/node_modules", "/opt/homebrew/lib")).toBe(true);
    expect(sameGlobalRoot("/opt/homebrew/lib/node_modules/", "/opt/homebrew/lib")).toBe(true);
    expect(sameGlobalRoot("/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules", "/opt/homebrew/lib")).toBe(false);
  });
});
