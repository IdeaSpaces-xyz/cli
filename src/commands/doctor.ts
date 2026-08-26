import { spawnSync } from "node:child_process";
import { loadConfig } from "../auth/credentials.js";
import { gitAvailability } from "../git.js";
import type { GitAvailability } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const MINIMUM_NODE_MAJOR = 20;

export type NodeAvailability =
  | { state: "usable"; version: string }
  | { state: "absent" }
  | { state: "unusable"; detail: string; exitCode: number | null }
  | { state: "unsupported"; version: string; major: number };

export interface DoctorCheck {
  state: string;
  required: boolean;
  ok: boolean;
  version: string | null;
  detail: string | null;
  exit_code: number | null;
  fix: string | null;
}

export interface RemoteAuthCheck extends DoctorCheck {
  state: "configured" | "not_configured";
  api_url: string | null;
}

export interface DoctorReport {
  schema_version: 1;
  ok: boolean;
  platform: string;
  checks: {
    node: DoctorCheck;
    git: DoctorCheck;
    remote_auth: RemoteAuthCheck;
  };
}

export interface DoctorRuntime {
  platform: string;
  node: () => NodeAvailability;
  git: () => GitAvailability;
  auth: () => { apiUrl: string; apiKey: string } | null;
}

/** Probe the `node` executable on PATH, not the runtime already executing this command. */
export function nodeAvailability(): NodeAvailability {
  const result = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    return {
      state: "unusable",
      detail: result.error.message,
      exitCode: result.status,
    };
  }

  const version = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    return {
      state: "unusable",
      detail:
        (result.stderr ?? "").trim() ||
        version ||
        `node --version exited ${result.status ?? "without a status"}`,
      exitCode: result.status,
    };
  }

  const major = /^v?(\d+)(?:\.|$)/.exec(version);
  if (!major) {
    return {
      state: "unusable",
      detail: `node --version returned an unrecognized version: ${version || "<empty>"}`,
      exitCode: result.status,
    };
  }
  const majorVersion = Number(major[1]);
  if (majorVersion < MINIMUM_NODE_MAJOR) {
    return { state: "unsupported", version, major: majorVersion };
  }
  return { state: "usable", version };
}

function nodeFix(platform: string, state: NodeAvailability["state"]): string {
  const action = state === "unusable" ? "Repair or reinstall" : "Install";
  if (platform === "darwin") {
    return `${action} Node.js 20 or later, then reopen your terminal: \`brew install node\`.`;
  }
  if (platform === "win32") {
    return `${action} Node.js 20 or later, then reopen your terminal: \`winget install OpenJS.NodeJS.LTS\`.`;
  }
  if (platform === "linux") {
    return `${action} Node.js 20 or later with your package manager or nodejs.org, then reopen your terminal.`;
  }
  return `${action} Node.js 20 or later from https://nodejs.org, then reopen your terminal.`;
}

function gitFix(platform: string, state: GitAvailability["state"]): string {
  if (state === "unusable") {
    return platform === "darwin"
      ? "Repair the macOS Command Line Tools, then retry: `xcode-select --install`."
      : "Repair or reinstall Git, then reopen your terminal and retry.";
  }
  if (platform === "darwin") {
    return "Install Git, then retry: `brew install git`.";
  }
  if (platform === "win32") {
    return "Install Git, then reopen your terminal: `winget install Git.Git`.";
  }
  if (platform === "linux") {
    return "Install Git with your package manager, then reopen your terminal.";
  }
  return "Install Git from https://git-scm.com, then reopen your terminal.";
}

export function buildDoctorReport(input: {
  platform: string;
  node: NodeAvailability;
  git: GitAvailability;
  auth: { apiUrl: string } | null;
}): DoctorReport {
  const node: DoctorCheck = (() => {
    switch (input.node.state) {
      case "usable":
        return {
          state: input.node.state,
          required: true,
          ok: true,
          version: input.node.version,
          detail: null,
          exit_code: null,
          fix: null,
        };
      case "unsupported":
        return {
          state: input.node.state,
          required: true,
          ok: false,
          version: input.node.version,
          detail: `Node.js ${MINIMUM_NODE_MAJOR} or later is required; found major version ${input.node.major}.`,
          exit_code: null,
          fix: nodeFix(input.platform, input.node.state),
        };
      case "unusable":
        return {
          state: input.node.state,
          required: true,
          ok: false,
          version: null,
          detail: input.node.detail,
          exit_code: input.node.exitCode,
          fix: nodeFix(input.platform, input.node.state),
        };
      case "absent":
        return {
          state: input.node.state,
          required: true,
          ok: false,
          version: null,
          detail: "The `node` executable is not available on PATH.",
          exit_code: null,
          fix: nodeFix(input.platform, input.node.state),
        };
    }
  })();

  const git: DoctorCheck = (() => {
    switch (input.git.state) {
      case "usable":
        return {
          state: input.git.state,
          required: true,
          ok: true,
          version: input.git.version,
          detail: null,
          exit_code: null,
          fix: null,
        };
      case "unusable":
        return {
          state: input.git.state,
          required: true,
          ok: false,
          version: null,
          detail: input.git.detail,
          exit_code: input.git.exitCode,
          fix: gitFix(input.platform, input.git.state),
        };
      case "absent":
        return {
          state: input.git.state,
          required: true,
          ok: false,
          version: null,
          detail: "The `git` executable is not available on PATH.",
          exit_code: null,
          fix: gitFix(input.platform, input.git.state),
        };
    }
  })();

  const remoteAuth: RemoteAuthCheck = input.auth
    ? {
        state: "configured",
        required: false,
        ok: true,
        version: null,
        detail: null,
        exit_code: null,
        fix: null,
        api_url: input.auth.apiUrl,
      }
    : {
        state: "not_configured",
        required: false,
        ok: false,
        version: null,
        detail: "Remote features are unavailable; local capture still works.",
        exit_code: null,
        fix: "Run `ideaspaces login` to enable publish, sync, and sharing.",
        api_url: null,
      };

  return {
    schema_version: 1,
    ok: node.ok && git.ok,
    platform: input.platform,
    checks: { node, git, remote_auth: remoteAuth },
  };
}

function formatCheck(label: string, check: DoctorCheck): string[] {
  const symbol = check.ok ? "✓" : check.required ? "✗" : "○";
  const value = check.version ?? check.state.replaceAll("_", " ");
  const lines = [`${symbol} ${label}: ${value}`];
  if (check.detail) lines.push(`  ${check.detail}`);
  if (check.fix) lines.push(`  Fix: ${check.fix}`);
  return lines;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "IdeaSpaces doctor",
    ...formatCheck("Node", report.checks.node),
    ...formatCheck("Git", report.checks.git),
    ...formatCheck("Remote auth", report.checks.remote_auth),
    "",
    report.ok ? "Ready for local IdeaSpaces." : "Required dependencies need attention.",
  ];
  return lines.join("\n");
}

const defaultRuntime: DoctorRuntime = {
  platform: process.platform,
  node: nodeAvailability,
  git: gitAvailability,
  auth: loadConfig,
};

export function makeDoctorCommand(runtime: DoctorRuntime = defaultRuntime): CommandDef {
  return {
    name: "doctor",
    description: "Check Node, Git, and remote-auth readiness",
    usage: "ideaspaces doctor [--json]",
    examples: ["ideaspaces doctor", "ideaspaces doctor --json"],
    async run(_args, _flags, global) {
      const report = buildDoctorReport({
        platform: runtime.platform,
        node: runtime.node(),
        git: runtime.git(),
        auth: runtime.auth(),
      });
      createOutput(global).result(report, formatDoctorReport(report));
      return report.ok ? 0 : 1;
    },
  };
}

export const doctorCommand = makeDoctorCommand();
