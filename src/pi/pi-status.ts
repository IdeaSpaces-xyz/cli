/**
 * `ideaspaces pi-status` — is the local pi runtime usable for a local agent?
 *
 * The detection contract for "Connect Pi", kept in the CLI so no
 * client parses `~/.pi` itself. Three checks, reported as structured data:
 *
 *   - **binary**   — is `pi` resolvable, and what version (`pi --version`)
 *   - **providers**— `~/.pi/agent/auth.json` entries (name + creds hint + expiry);
 *                    never the tokens themselves
 *   - **extensions**— do the pi-is-space / pi-local-context paths resolve as pi
 *                    would load them (a `pi.extensions` manifest, or index.ts/js)
 *
 * `ready` = binary present && ≥1 provider configured — the "dev-first" bar.
 * `extensionsResolvable` is reported separately: it's the distribution concern
 * (bundling the extensions), not a gate on connecting. Auth-independent — this
 * reads only the local pi install, never the IdeaSpaces account.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createOutput } from "../output.js";
import { readAuthFile, resolvePiAuthPath } from "./pi-auth.js";
import type { PiAuth } from "./pi-auth.js";
import type { CommandDef } from "../types.js";

/** One pi provider from `auth.json`, creds redacted to a presence + expiry hint. */
export interface PiProvider {
  name: string;
  /** A credential is present — an API key or OAuth token (value never exposed). */
  hasCreds: boolean;
  /** Access-token expiry (epoch ms) when the entry carries one, else null. */
  expiresAt: number | null;
  /** `expiresAt` is in the past. A hint only — a refresh token still renews it. */
  expired: boolean;
}

/** Whether an extension path resolves the way pi would load it. */
export interface PiExtensionCheck {
  name: string;
  path: string;
  resolvable: boolean;
}

export interface PiBinary {
  present: boolean;
  path: string;
  version: string | null;
}

export interface PiStatus {
  binary: PiBinary;
  providers: PiProvider[];
  /** ≥1 provider carries credentials (expired-but-refreshable still counts). */
  configured: boolean;
  extensions: PiExtensionCheck[];
  /** Every supplied extension resolves. False when none were supplied to check. */
  extensionsResolvable: boolean;
  /** The "Connect Pi" bar: a usable binary + a configured provider. */
  ready: boolean;
}

/**
 * Pure status derivation — all IO (spawn, file reads, path checks) happens in the
 * command and is passed in, so this is fully unit-testable. `configured` keys on
 * *presence* of creds, not non-expiry: pi refreshes an expired access token from
 * its refresh token, so an expired entry is still usable. `expired` is surfaced
 * per provider as a hint; real validity is only proven by an actual turn.
 *
 * `hasCreds` spans both credential forms: an API key (`key`) or OAuth tokens
 * (`access`/`refresh`). The earlier check keyed only on `access`/`refresh`, so an
 * API-key provider — the shape `pi-login --api-key` writes — read as unconfigured.
 */
export function derivePiStatus(input: {
  binary: PiBinary;
  auth: PiAuth | null;
  extensions: PiExtensionCheck[];
  now: number;
}): PiStatus {
  const providers: PiProvider[] = Object.entries(input.auth ?? {}).map(([name, v]) => {
    const hasCreds = Boolean(v && (v.key || v.access || v.refresh));
    const expiresAt = typeof v?.expires === "number" ? v.expires : null;
    return { name, hasCreds, expiresAt, expired: expiresAt != null && expiresAt <= input.now };
  });
  const configured = providers.some((p) => p.hasCreds);
  const extensionsResolvable =
    input.extensions.length > 0 && input.extensions.every((e) => e.resolvable);
  return {
    binary: input.binary,
    providers,
    configured,
    extensions: input.extensions,
    extensionsResolvable,
    ready: input.binary.present && configured,
  };
}

/**
 * Does a path resolve as a pi extension? Mirrors pi's loader: a directory with a
 * `pi.extensions` manifest (non-empty) or an `index.ts`/`index.js`, or a direct
 * `.ts`/`.js` file. Never executes anything — a static shape check.
 */
export function resolveExtension(path: string): PiExtensionCheck {
  const name = basename(path.replace(/[/\\]+$/, "")) || path;
  const check = (resolvable: boolean): PiExtensionCheck => ({ name, path, resolvable });
  if (!existsSync(path)) return check(false);
  if (/\.[cm]?[jt]s$/.test(path)) return check(true); // a direct entry file
  const pkgPath = join(path, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        pi?: { extensions?: unknown };
      };
      const exts = pkg.pi?.extensions;
      if (Array.isArray(exts) && exts.length > 0) return check(true);
    } catch {
      /* unreadable/invalid package.json — fall through to index check */
    }
  }
  return check(existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js")));
}

/** Probe the pi binary via `--version`; ENOENT/non-zero → not present. */
function probeBinary(piBin: string): PiBinary {
  try {
    const res = spawnSync(piBin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0) return { present: false, path: piBin, version: null };
    const m = /\d+\.\d+\.\d+[\w.-]*/.exec(res.stdout ?? "");
    return { present: true, path: piBin, version: m ? m[0] : null };
  } catch {
    return { present: false, path: piBin, version: null };
  }
}

function formatHuman(s: PiStatus): string {
  const out: string[] = [];
  out.push(
    s.binary.present
      ? `Pi: present${s.binary.version ? ` (${s.binary.version})` : ""} — ${s.binary.path}`
      : `Pi: not found (${s.binary.path}). Install pi to enable the local agent.`,
  );
  if (s.providers.length) {
    const list = s.providers
      .map((p) => `${p.name}${!p.hasCreds ? " (no creds)" : p.expired ? " (expired)" : ""}`)
      .join(", ");
    out.push(`Configured: ${s.configured ? "yes" : "no"} — providers: ${list}`);
  } else {
    out.push("Configured: no — no providers in ~/.pi/agent/auth.json");
  }
  if (s.extensions.length) {
    const list = s.extensions.map((e) => `${e.name} (${e.resolvable ? "ok" : "missing"})`).join(", ");
    out.push(`Extensions: ${list}`);
  } else {
    out.push("Extensions: none checked — pass --ext or set IDEASPACES_PI_EXTENSIONS");
  }
  out.push(`Ready: ${s.ready ? "yes" : "no"}`);
  return out.join("\n");
}

export const piStatusCommand: CommandDef = {
  name: "pi-status",
  description: "Is the local pi runtime usable for a local agent? (binary, providers, extensions)",
  usage: "ideaspaces pi-status [--pi-bin <path>] [--ext <p1,p2>] [--json]",
  examples: [
    "ideaspaces pi-status",
    "ideaspaces pi-status --json",
    "ideaspaces pi-status --ext /path/pi-is-space,/path/pi-local-context",
    "IDEASPACES_PI_EXTENSIONS=/path/pi-is-space,/path/pi-local-context ideaspaces pi-status  # env fallback",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    const piBin = typeof flags["pi-bin"] === "string" ? flags["pi-bin"] : "pi";
    const binary = probeBinary(piBin);
    // Same resolved path pi-login writes and the bundled pi reads (honors
    // PI_CODING_AGENT_DIR), so detection and write can never diverge.
    const auth = readAuthFile(resolvePiAuthPath());

    // Extension paths: same source as `conversation send --local` — the caller
    // supplies them (env in dev, the bundle when shipped). Absent → we simply
    // report no extension checks (extensionsResolvable stays false).
    const extFlag = typeof flags.ext === "string" ? flags.ext : process.env.IDEASPACES_PI_EXTENSIONS;
    const extensions = (extFlag ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(resolveExtension);

    const status = derivePiStatus({ binary, auth, extensions, now: Date.now() });
    output.result(status, formatHuman(status));
    return 0;
  },
};
