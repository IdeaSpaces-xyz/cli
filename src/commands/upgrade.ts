import { spawnSync } from "node:child_process";
import { parseBool } from "../argv.js";
import { createOutput } from "../output.js";
import {
  detectInstall,
  NPM_INSTALL,
  realPathOr,
  sameGlobalRoot,
  selfPath,
  updateAdvice,
  type Install,
} from "../install-kind.js";
import { fetchLatestVersion, isBehind, mayCheckForUpdates, refreshUpdateState, UPDATE_CHECK_COMMAND } from "../update-check.js";
import { CLI_VERSION } from "../version.js";
import type { CommandDef } from "../types.js";

const WINDOWS = process.platform === "win32";

export interface UpgradeRuntime {
  current: string;
  install: () => Install;
  latest: () => Promise<string>;
  /** `npm root -g`, or null when npm cannot say. */
  npmRoot: () => string | null;
  /** Runs the install, keeping stdout clean for --json; returns npm's exit status. */
  npmInstall: (json: boolean) => number;
  /** What the copy at this path says it is now, or null. */
  installedVersion: (path: string) => string | null;
}

const defaultRuntime: UpgradeRuntime = {
  current: CLI_VERSION,
  install: detectInstall,
  latest: () => fetchLatestVersion({ timeoutMs: 10_000 }),
  npmRoot() {
    // npm is a .cmd on Windows, which Node only runs through a shell. Every argument here is fixed.
    const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15_000, shell: WINDOWS });
    if (result.error || result.status !== 0) return null;
    const root = result.stdout.trim();
    return root ? realPathOr(root) : null;
  },
  npmInstall(json) {
    const result = spawnSync("npm", ["install", "-g", "@ideaspaces/cli@latest"], {
      stdio: json ? ["ignore", process.stderr.fd, process.stderr.fd] : "inherit",
      shell: WINDOWS,
    });
    return result.status ?? 1;
  },
  installedVersion(path) {
    const result = spawnSync(process.execPath, [path, "--version"], { encoding: "utf8", timeout: 15_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  },
};

export function makeUpgradeCommand(runtime: UpgradeRuntime = defaultRuntime): CommandDef {
  return {
    name: "upgrade",
    description: "Update this CLI itself, or --check to see if it is behind (`update` is for forks)",
    usage: "ideaspaces upgrade [--check] [--json]",
    help:
      "Finds how this copy was installed. An npm global install is updated in place with\n" +
      `\`${NPM_INSTALL}\`. A copy that came with Idea Explorer, the IdeaSpaces plugin or Pi\n` +
      "updates with them, and this command names what to run; each copy on a machine updates on its own.\n" +
      "Running `upgrade` is the go-ahead: it installs at once and takes no --yes.\n" +
      "--check reads the npm registry and changes nothing. `ideaspaces update` is a different\n" +
      "command: it brings source changes into a fork.",
    examples: ["ideaspaces upgrade --check", "ideaspaces upgrade"],
    async run(_args, flags, global) {
      const output = createOutput(global);
      const check = parseBool(flags.check, false);
      const install = runtime.install();
      const advice = updateAdvice(install);
      const current = runtime.current;

      const body = (fields: { latest: string | null; behind: boolean | null; upgraded?: boolean }) => ({
        current,
        latest: fields.latest,
        behind: fields.behind,
        upgraded: fields.upgraded ?? false,
        install: install.kind,
        path: install.path,
        advice: advice.text,
      });
      const report = (fields: Parameters<typeof body>[0], text: string): void => output.result(body(fields), text);
      // A failure answers in the same shape, so --json never leaves a caller with empty stdout.
      const fail = (fields: Parameters<typeof body>[0], message: string): number => {
        if (global.json) process.stdout.write(JSON.stringify({ ...body(fields), error: message }, null, 2) + "\n");
        output.error(message);
        return 1;
      };

      // The app's copy follows the app, and host mode stays off the network on its own.
      if (install.kind === "app") {
        report({ latest: null, behind: null }, `ideaspaces ${current}\n${advice.text}`);
        return check ? 0 : 1;
      }

      let latest: string;
      try {
        latest = await runtime.latest();
      } catch (err) {
        const manual = install.kind === "npm" && !check ? ` To update without this check, run: ${NPM_INSTALL}` : "";
        return fail(
          { latest: null, behind: null },
          `Could not read the latest version from the npm registry: ${err instanceof Error ? err.message : String(err)}\n` +
            `You have ${current}. Nothing changed. Check your connection and retry.${manual}`,
        );
      }

      const behind = isBehind(current, latest);
      if (!behind) {
        const same = current === latest;
        report({ latest, behind }, same ? `ideaspaces ${current} is the latest.` : `ideaspaces ${current} is ahead of the latest published version, ${latest}.`);
        return 0;
      }

      const heading = `You have ${current}. The latest is ${latest}.`;
      if (check) {
        report({ latest, behind }, `${heading}\n${advice.text}`);
        return 0;
      }
      if (install.kind !== "npm") {
        report({ latest, behind }, `${heading}\n${advice.text}`);
        return 1;
      }

      // A second Node on PATH has its own global folder: installing there would leave this copy old.
      const npmRoot = runtime.npmRoot();
      if (!npmRoot) {
        return fail({ latest, behind }, `${heading}\nCould not run \`npm root -g\`, so nothing changed. With the npm that installed this copy, run: ${NPM_INSTALL}`);
      }
      if (!install.owner || !sameGlobalRoot(npmRoot, install.owner)) {
        return fail(
          { latest, behind },
          `${heading}\nThe npm on your PATH installs into ${npmRoot}, but this copy runs from ${install.path}, so nothing changed.\n` +
            `Use the Node that installed this copy, then run: ${NPM_INSTALL}`,
        );
      }

      output.progress(`${heading} Running: ${NPM_INSTALL}`);
      const status = runtime.npmInstall(global.json);
      if (status !== 0) {
        return fail({ latest, behind }, `npm exited with ${status}, and this copy may still be ${current}.\nFix what npm reported, then run: ${NPM_INSTALL}`);
      }

      // npm follows your .npmrc and the registry check may not, so a mirror can give less than `latest`.
      const now = runtime.installedVersion(selfPath());
      if (now === null || !isBehind(current, now)) {
        return fail({ latest, behind }, `npm finished, but this copy still reports ${now ?? "no version"}. Check \`which ideaspaces\` and \`npm root -g\`.`);
      }
      report({ latest: now, behind: isBehind(now, latest), upgraded: true }, `Upgraded ideaspaces ${current} to ${now}.`);
      return 0;
    },
  };
}

export const upgradeCommand = makeUpgradeCommand();

/** Hidden: the detached child `afterCommand` starts. Every failure stays silent. */
export const updateCheckCommand: CommandDef = {
  name: UPDATE_CHECK_COMMAND,
  description: "Refresh the update check",
  usage: `ideaspaces ${UPDATE_CHECK_COMMAND}`,
  async run() {
    if (!mayCheckForUpdates()) return 0;
    await refreshUpdateState().catch(() => {});
    return 0;
  },
};
