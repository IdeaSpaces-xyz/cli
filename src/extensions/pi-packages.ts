/**
 * Pi packages through the pi binary — `pi install`, `pi remove`, `pi update`,
 * `pi list` — never through `~/.pi` or `.pi/` directly, so the CLI stays an
 * external-runtime shell like it is for turns. `pi list` has no `--json`
 * (pi-mono `src/package-manager-cli.ts`, 0.85.1), so its text is parsed here
 * against a verbatim fixture; the parser is the one place that knows the layout.
 *
 * Scopes map onto pi's own: `user` → `~/.pi/agent/settings.json`, `agent` →
 * `.pi/settings.json` in the agent repo (pi's `-l` project scope, run with the
 * agent repo as cwd).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionRow, ExtensionScope } from "./model.js";

/** `pi install <source> [-l] --approve` — `--approve` trusts the project's own
 * settings for this one command instead of prompting (a headless caller cannot
 * answer pi's trust dialog). */
export function piInstallArgs(source: string, scope: ExtensionScope): string[] {
  return scope === "agent" ? ["install", source, "-l", "--approve"] : ["install", source];
}

export function piRemoveArgs(source: string, scope: ExtensionScope): string[] {
  return scope === "agent" ? ["remove", source, "-l", "--approve"] : ["remove", source];
}

/** `pi update <source>` updates one package; without a source, every package
 * (`--extensions` keeps pi itself out of it). */
export function piUpdateArgs(source?: string): string[] {
  return source ? ["update", source] : ["update", "--extensions"];
}

export const PI_LIST_ARGS = ["list"] as const;

/** Parse `pi list` (0.85.x) — verbatim layout:
 *
 *     User packages:
 *       npm:pi-web-access
 *         /Users/u/.pi/agent/npm/node_modules/pi-web-access
 *       ../relative/path (filtered)
 *         /abs/path
 *
 *     Project packages:
 *       git:github.com/user/repo@v1
 *         /repo/.pi/git/github.com/user/repo
 *
 * `No packages installed.` → []. A source line is indented two spaces, its
 * install path four; the path is optional (a declared-but-uninstalled source).
 * `declaredBy` is the agent repo for project rows, which pi resolved from cwd. */
export function parsePiList(stdout: string, agentRoot: string | null): ExtensionRow[] {
  const rows: ExtensionRow[] = [];
  let scope: ExtensionScope | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (/^User packages:/.test(line)) { scope = "user"; continue; }
    if (/^Project packages:/.test(line)) { scope = "agent"; continue; }
    if (!scope) continue;
    const pathMatch = /^ {4}(\S.*)$/.exec(line);
    if (pathMatch && rows.length) {
      rows[rows.length - 1].installPath = pathMatch[1].trim();
      continue;
    }
    const sourceMatch = /^ {2}(\S.*?)( \(filtered\))?$/.exec(line);
    if (!sourceMatch) continue;
    const source = sourceMatch[1].trim();
    rows.push({
      runtime: "pi",
      id: source,
      source,
      version: piSourceVersion(source),
      scope,
      enabled: true,
      installPath: null,
      declaredBy: scope === "agent" ? agentRoot : null,
    });
  }
  return rows;
}

/** The pinned version or ref a source names, if any: `npm:pkg@1.2.3` → `1.2.3`,
 * `git:host/repo@v1` → `v1`. A local path has none. */
export function piSourceVersion(source: string): string | null {
  if (!/^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source)) return null;
  const body = source.replace(/^npm:/, "");
  // npm scoped names carry a leading `@`; the version is the `@` after the name.
  const at = body.lastIndexOf("@");
  if (at <= 0) return null;
  return body.slice(at + 1) || null;
}

/** The `packages` an agent repo's `.pi/settings.json` declares, as sources.
 * pi accepts a string or an object with `source` plus filters; only the source
 * matters here. Missing file or no `packages` → []. Malformed JSON throws with
 * the path named, since a synced agent repo with a broken declaration should
 * not silently load nothing. */
export function readPiAgentDeclarations(agentRoot: string): string[] {
  const file = join(agentRoot, ".pi", "settings.json");
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsePiPackagesField(parsed);
}

export function parsePiPackagesField(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const packages = (settings as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];
  const out: string[] = [];
  for (const entry of packages) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
      out.push((entry as { source: string }).source.trim());
    }
  }
  return out;
}

/** The package name at an install path (its `package.json`), used to recognise
 * the same extension reached by two sources — e.g. a bundled `pi-is-space` and
 * a library checkout of it. Falls back to the directory's basename. */
export function piPackageName(installPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(installPath, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name) return pkg.name;
  } catch {
    // Not a package dir (a single-file extension, or no package.json) — basename it.
  }
  return installPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? installPath;
}

/** The skills dir a package ships, if it has one — `--extension` loads a
 * package's code but not its skills, so a turn forwards this as `--skill`. */
export function piPackageSkillsDir(installPath: string): string | null {
  const dir = join(installPath, "skills");
  return existsSync(dir) ? dir : null;
}
