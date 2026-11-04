import { describe, expect, it, vi } from "vitest";
import { makeUpgradeCommand, updateCheckCommand, type UpgradeRuntime } from "../commands/upgrade.js";
import { findCommand_, printHelp } from "../router.js";
import type { Install } from "../install-kind.js";
import type { GlobalFlags } from "../types.js";
import { captureJson, captureStdout } from "./helpers.js";

const HUMAN: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const JSON_GLOBAL: GlobalFlags = { ...HUMAN, json: true };
const NPM: Install = { kind: "npm", path: "/usr/local/lib/node_modules/@ideaspaces/cli/bundle/ideaspaces.js", owner: "/usr/local/lib" };

function runtime(overrides: Partial<UpgradeRuntime> = {}): UpgradeRuntime {
  return {
    current: "0.7.1",
    install: () => NPM,
    latest: async () => "0.8.0",
    npmRoot: () => "/usr/local/lib/node_modules",
    npmInstall: vi.fn(() => 0),
    installedVersion: () => "0.8.0",
    ...overrides,
  };
}

async function stderrOf(run: () => Promise<number>): Promise<{ exit: number; stderr: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    return { exit: await run(), stderr: lines.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("ideaspaces upgrade", () => {
  it("is a listed command, and `update` is still the fork command", () => {
    expect(findCommand_("upgrade")?.name).toBe("upgrade");
    expect(findCommand_("update")?.usage).toBe("ideaspaces update [--yes]");
    expect(findCommand_("update")?.help).toBe("To update this CLI itself, run: ideaspaces upgrade");
  });

  it("--check reports and installs nothing", async () => {
    const rt = runtime();
    const { exit, json } = await captureJson(() => makeUpgradeCommand(rt).run([], { check: true }, JSON_GLOBAL));

    expect(exit).toBe(0);
    expect(json).toMatchObject({ current: "0.7.1", latest: "0.8.0", behind: true, upgraded: false, install: "npm", advice: "Run: ideaspaces upgrade" });
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it("runs the install for npm, then checks the copy that now runs", async () => {
    const rt = runtime();
    const { exit, json } = await captureJson(() => makeUpgradeCommand(rt).run([], {}, JSON_GLOBAL));

    expect(exit).toBe(0);
    expect(rt.npmInstall).toHaveBeenCalledWith(true);
    expect(json).toMatchObject({ latest: "0.8.0", behind: false, upgraded: true });
  });

  it("leaves a current copy alone", async () => {
    const rt = runtime({ latest: async () => "0.7.1" });
    const { exit, out } = await captureStdout(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(0);
    expect(out).toContain("0.7.1 is the latest");
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it("does not downgrade a copy ahead of the registry", async () => {
    const rt = runtime({ latest: async () => "0.6.0" });
    const { exit, out } = await captureStdout(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(0);
    expect(out).toContain("ahead of the latest published version, 0.6.0");
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it.each<[Install["kind"], string]>([
    ["plugin", "claude plugin update ideaspaces@ideaspaces-xyz"],
    ["pi", "pi update --extensions"],
    ["pnpm", "pnpm add -g @ideaspaces/cli@latest"],
    ["dependency", "Update @ideaspaces/cli there"],
    ["unknown", "npm install -g @ideaspaces/cli@latest"],
  ])("does not install for a %s copy; it says what to do", async (kind, says) => {
    const rt = runtime({ install: () => ({ kind, path: "/x/ideaspaces.js", owner: "/x" }) });
    const { exit, out } = await captureStdout(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(out).toContain(says);
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it("the app's copy points at the app without touching the network", async () => {
    const latest = vi.fn(async () => "0.8.0");
    const rt = runtime({ install: () => ({ kind: "app", path: "/x/ideaspaces.js" }), latest });

    const { exit, out } = await captureStdout(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(out).toContain("Update the app");
    expect(latest).not.toHaveBeenCalled();
  });

  it("refuses when the npm on PATH would install somewhere else", async () => {
    const rt = runtime({ npmRoot: () => "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules" });
    const { exit, stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(stderr).toContain("installs into /Users/a/.nvm");
    expect(stderr).toContain(NPM.path);
    expect(stderr).toContain("nothing changed");
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it("refuses when npm cannot be run", async () => {
    const rt = runtime({ npmRoot: () => null });
    const { exit, stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(stderr).toContain("npm install -g @ideaspaces/cli@latest");
    expect(rt.npmInstall).not.toHaveBeenCalled();
  });

  it("says so when npm fails", async () => {
    const rt = runtime({ npmInstall: vi.fn(() => 243) });
    const { exit, stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(stderr).toContain("npm exited with 243");
    expect(stderr).toContain("npm install -g @ideaspaces/cli@latest");
  });

  it("says so when the running copy did not move", async () => {
    const rt = runtime({ installedVersion: () => "0.7.1" });
    const { exit, stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(exit).toBe(1);
    expect(stderr).toContain("still reports 0.7.1");
  });

  it("a mirror that gives less than the latest still counts as an upgrade, and says what landed", async () => {
    const rt = runtime({ latest: async () => "0.9.0", installedVersion: () => "0.8.0" });
    const { exit, json } = await captureJson(() => makeUpgradeCommand(rt).run([], {}, JSON_GLOBAL));

    expect(exit).toBe(0);
    expect(json).toMatchObject({ upgraded: true, latest: "0.8.0", behind: true });
  });

  it.each<[string, Partial<UpgradeRuntime>]>([
    ["the registry is unreachable", { latest: async () => { throw new Error("fetch failed"); } }],
    ["npm cannot be run", { npmRoot: () => null }],
    ["npm belongs to another folder", { npmRoot: () => "/elsewhere/node_modules" }],
    ["npm fails", { npmInstall: vi.fn(() => 1) }],
    ["the copy does not move", { installedVersion: () => "0.7.1" }],
  ])("--json answers in the same shape when %s", async (_name, change) => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { exit, json } = await captureJson(() => makeUpgradeCommand(runtime(change)).run([], {}, JSON_GLOBAL));
      expect(exit).toBe(1);
      expect(json).toMatchObject({ current: "0.7.1", upgraded: false, install: "npm" });
      expect(json.error).toEqual(expect.any(String));
    } finally {
      spy.mockRestore();
    }
  });

  it("offline, an npm copy still gets the command that needs no check", async () => {
    const rt = runtime({ latest: async () => { throw new Error("fetch failed"); } });
    const { stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], {}, HUMAN));

    expect(stderr).toContain("npm install -g @ideaspaces/cli@latest");
  });

  it("offline, says what you have and that nothing changed", async () => {
    const rt = runtime({ latest: async () => { throw new Error("fetch failed"); } });
    const { exit, stderr } = await stderrOf(() => makeUpgradeCommand(rt).run([], { check: true }, HUMAN));

    expect(exit).toBe(1);
    expect(stderr).toContain("fetch failed");
    expect(stderr).toContain("You have 0.7.1. Nothing changed.");
  });
});

describe("the background check command", () => {
  it("is reachable but never listed, and stays off the network when opted out", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    try {
      expect(findCommand_("__update-check")).toBe(updateCheckCommand);
      const help: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { help.push(String(chunk)); return true; });
      printHelp();
      spy.mockRestore();
      expect(help.join("")).toContain("upgrade");
      expect(help.join("")).not.toContain("__update-check");
      await expect(updateCheckCommand.run([], {}, HUMAN)).resolves.toBe(0);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
