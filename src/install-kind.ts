/**
 * How this copy of the CLI reached the machine, read from where it runs. One machine can hold
 * several copies, each updated by a different route, so "update the CLI" only means something
 * once we know which copy this is.
 *
 * Path-only and cheap, because the update notice reads it after a command. `upgrade` confirms an
 * `npm` answer with `npm root -g` before it installs anything. Nothing here guesses a command it
 * cannot name: what is not recognised is `unknown`, and only `npm` is ever installed by this CLI.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHostAuth } from "./auth/credentials.js";

export type InstallKind =
  | "npm" | "pnpm" | "yarn" | "bun" | "npx"
  | "app" | "plugin" | "pi"
  | "dependency" | "source" | "unknown";

export interface Install {
  kind: InstallKind;
  /** This copy's entry file, as a real path. */
  path: string;
  /** What holds the copy: the global `node_modules` parent, the project, the plugin or the checkout. */
  owner?: string;
}

export interface Advice {
  /** One sentence for a person, naming the command where there is one. */
  text: string;
  /** The exact command, when one exists. */
  command: string | null;
}

export const NPM_INSTALL = "npm install -g @ideaspaces/cli@latest";

const PACKAGE_DIR = "/node_modules/@ideaspaces/cli/";

/** The running entry file: the bundle in anything shipped. */
export function selfPath(): string {
  const path = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function classifyInstall(
  path: string,
  env: { host: boolean; exists: (path: string) => boolean },
): Install {
  const p = path.replaceAll("\\", "/");
  // The app sets host mode and ships the bundle alone under resources/cli.
  if (env.host || p.endsWith("/resources/cli/ideaspaces.js")) return { kind: "app", path };

  const at = p.lastIndexOf(PACKAGE_DIR);
  if (at === -1) {
    const plugin = /^(.*)\/cli\/bundle\/ideaspaces\.js$/.exec(p);
    if (plugin && env.exists(`${plugin[1]}/.claude-plugin/plugin.json`)) {
      return { kind: "plugin", path, owner: plugin[1] };
    }
    const checkout = /^(.*)\/(?:bundle|dist)\/[^/]+\.js$/.exec(p);
    if (checkout && env.exists(`${checkout[1]}/src/main.ts`)) {
      return { kind: "source", path, owner: checkout[1] };
    }
    return { kind: "unknown", path };
  }

  // The last match: a copy nested in another package belongs to that package.
  const owner = p.slice(0, at);
  if (owner.endsWith("/pi-is-space")) return { kind: "pi", path, owner };
  if (/\/_npx\//.test(owner)) return { kind: "npx", path, owner };
  if (/\/\.bun\/install\/global$/.test(owner)) return { kind: "bun", path, owner };
  if (/\/pnpm\/global\//i.test(owner)) return { kind: "pnpm", path, owner };
  if (/\/yarn\/(?:data\/)?global$/i.test(owner)) return { kind: "yarn", path, owner };
  if (/\/\.pnpm\//.test(owner) || env.exists(`${owner}/package.json`)) {
    return { kind: "dependency", path, owner };
  }
  // A global prefix holds node_modules with no package.json beside it; a project always has one.
  return { kind: "npm", path, owner };
}

export function detectInstall(path: string = selfPath()): Install {
  return classifyInstall(path, { host: isHostAuth(), exists: existsSync });
}

/** What a person does to update this copy. */
export function updateAdvice(install: Install): Advice {
  const run = (command: string): Advice => ({ text: `Run: ${command}`, command });
  switch (install.kind) {
    case "npm": return run("ideaspaces upgrade");
    case "pnpm": return run("pnpm add -g @ideaspaces/cli@latest");
    case "yarn": return run("yarn global add @ideaspaces/cli@latest");
    case "bun": return run("bun add -g @ideaspaces/cli@latest");
    case "npx": return run("npx @ideaspaces/cli@latest");
    case "app":
      return { text: "This copy comes with Idea Explorer. Update the app.", command: null };
    case "plugin":
      return {
        text: "This copy comes with the IdeaSpaces plugin. Update the plugin, in Claude Code: claude plugin update ideaspaces@ideaspaces-xyz, then restart.",
        command: "claude plugin update ideaspaces@ideaspaces-xyz",
      };
    case "pi":
      return {
        text: "This copy comes with the IdeaSpaces package for Pi. Run: pi update --extensions",
        command: "pi update --extensions",
      };
    case "dependency":
      return { text: `This copy is a dependency of ${install.owner}. Update @ideaspaces/cli there.`, command: null };
    case "source":
      return {
        text: `This copy is built from source at ${install.owner}. Pull, then run: npm ci && npm run build`,
        command: "npm ci && npm run build",
      };
    case "unknown":
      return {
        text: `Could not tell how this copy was installed (${install.path}). If npm installed it, run: ${NPM_INSTALL}`,
        command: null,
      };
  }
}

/** Kinds a person installed on their own PATH, the only ones the notice speaks to. */
export const NOTICE_KINDS: ReadonlySet<InstallKind> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** `npm root -g` belongs to `owner` when it is that owner's node_modules. */
export function sameGlobalRoot(npmRoot: string, owner: string): boolean {
  const norm = (p: string) => {
    const unix = p.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? unix.toLowerCase() : unix;
  };
  return norm(npmRoot) === norm(join(owner, "node_modules"));
}

export function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
