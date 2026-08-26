import { describe, expect, it } from "vitest";
import { buildDoctorReport, formatDoctorReport, makeDoctorCommand } from "../commands/doctor.js";
import { GIT_MISSING_HINT, GIT_UNUSABLE_HINT } from "../git.js";
import { captureJson, captureStdout } from "./helpers.js";
import type { GlobalFlags } from "../types.js";

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

function runtime(overrides: Partial<Parameters<typeof makeDoctorCommand>[0]> = {}) {
  return {
    platform: "darwin",
    node: () => ({ state: "usable" as const, version: "v22.14.0" }),
    git: () => ({ state: "usable" as const, version: "git version 2.48.0" }),
    auth: () => null,
    ...overrides,
  };
}

describe("ideaspaces doctor", () => {
  it("emits a stable versioned JSON report without requiring remote auth", async () => {
    const command = makeDoctorCommand(runtime());

    const { exit, json } = await captureJson(() => command.run([], {}, JSON_GLOBAL));

    expect(exit).toBe(0);
    expect(json).toEqual({
      schema_version: 1,
      ok: true,
      platform: "darwin",
      checks: {
        node: {
          state: "usable",
          required: true,
          ok: true,
          version: "v22.14.0",
          detail: null,
          exit_code: null,
          fix: null,
        },
        git: {
          state: "usable",
          required: true,
          ok: true,
          version: "git version 2.48.0",
          detail: null,
          exit_code: null,
          fix: null,
        },
        remote_auth: {
          state: "not_configured",
          required: false,
          ok: false,
          version: null,
          detail: "Remote features are unavailable; local capture still works.",
          exit_code: null,
          fix: "Run `ideaspaces login` to enable publish, sync, and sharing.",
          api_url: null,
        },
      },
    });
  });

  it("reports the S1 nonzero Git shim as unusable and exits nonzero", async () => {
    const command = makeDoctorCommand(runtime({
      git: () => ({
        state: "unusable",
        hint: GIT_UNUSABLE_HINT,
        detail: "xcrun: error: active developer path is missing",
        exitCode: 69,
      }),
    }));

    const { exit, json } = await captureJson(() => command.run([], {}, JSON_GLOBAL));

    expect(exit).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.checks.git).toEqual({
      state: "unusable",
      required: true,
      ok: false,
      version: null,
      detail: "xcrun: error: active developer path is missing",
      exit_code: 69,
      fix: "Repair the macOS Command Line Tools, then retry: `xcode-select --install`.",
    });
  });

  it("keeps absent Git distinct from unusable Git", () => {
    const report = buildDoctorReport({
      platform: "win32",
      node: { state: "usable", version: "v20.19.0" },
      git: { state: "absent", hint: GIT_MISSING_HINT },
      auth: null,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.git.state).toBe("absent");
    expect(report.checks.git.detail).toBe("The `git` executable is not available on PATH.");
    expect(report.checks.git.exit_code).toBeNull();
    expect(report.checks.git.fix).toContain("winget install Git.Git");
  });

  it("fails when Node is absent, unusable, or older than Node 20", () => {
    for (const node of [
      { state: "absent" as const },
      { state: "unusable" as const, detail: "node shim failed", exitCode: 2 },
      { state: "unsupported" as const, version: "v18.20.0", major: 18 },
    ]) {
      const report = buildDoctorReport({
        platform: "linux",
        node,
        git: { state: "usable", version: "git version 2.43.0" },
        auth: null,
      });
      expect(report.ok).toBe(false);
      expect(report.checks.node.state).toBe(node.state);
      expect(report.checks.node.fix).toContain("Node.js 20 or later");
    }
  });

  it("reports configured remote auth without exposing the API key", async () => {
    const command = makeDoctorCommand(runtime({
      auth: () => ({ apiUrl: "https://api.example.test", apiKey: "never-print-me" }),
    }));

    const { exit, out } = await captureStdout(() => command.run([], {}, JSON_GLOBAL));

    expect(exit).toBe(0);
    expect(JSON.parse(out).checks.remote_auth).toMatchObject({
      state: "configured",
      required: false,
      ok: true,
      api_url: "https://api.example.test",
    });
    expect(out).not.toContain("never-print-me");
  });

  it("renders human checks, fixes, and the required-failure summary", async () => {
    const command = makeDoctorCommand(runtime({
      git: () => ({
        state: "unusable",
        hint: GIT_UNUSABLE_HINT,
        detail: "xcrun failed",
        exitCode: 69,
      }),
    }));

    const { exit, out } = await captureStdout(() => command.run([], {}, HUMAN_GLOBAL));

    expect(exit).toBe(1);
    expect(out).toContain("✓ Node: v22.14.0");
    expect(out).toContain("✗ Git: unusable");
    expect(out).toContain("xcode-select --install");
    expect(out).toContain("○ Remote auth: not configured");
    expect(out).toContain("Required dependencies need attention.");
  });

  it("formats a ready report without repair lines for required checks", () => {
    const report = buildDoctorReport({
      platform: "linux",
      node: { state: "usable", version: "v20.19.0" },
      git: { state: "usable", version: "git version 2.43.0" },
      auth: { apiUrl: "https://api.ideaspaces.xyz" },
    });

    expect(formatDoctorReport(report)).toContain("Ready for local IdeaSpaces.");
    expect(formatDoctorReport(report)).not.toContain("Fix:");
  });
});
