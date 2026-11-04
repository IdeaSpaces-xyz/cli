/**
 * Whether a newer CLI is out. The npm registry is the source: it holds what `npm install` would
 * give. A server-stated minimum does not exist yet, so "behind" means behind the latest published
 * version, never "too old to work".
 *
 * The notice runs after a command and must never slow it or reach anything parsed. It reads one
 * small file; when that file is a day old it starts a detached child to refresh it and moves on.
 * The first run after a release therefore prints nothing; a later run does.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./auth/config-dir.js";
import { isHostAuth } from "./auth/credentials.js";
import { detectInstall, NOTICE_KINDS, selfPath, updateAdvice, type Install } from "./install-kind.js";
import { CLI_VERSION } from "./version.js";

export const UPDATE_CHECK_COMMAND = "__update-check";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** Commands whose output belongs to someone else, or that already answer the question. */
const NO_NOTICE_COMMANDS = new Set(["credential", "upgrade", UPDATE_CHECK_COMMAND]);

type Env = Record<string, string | undefined>;

export interface UpdateState {
  /** When a check last started, in ms. Written before the check, so a failing one still waits a day. */
  checked_at?: number;
  latest?: string;
  /** When the notice last printed, in ms. */
  notified_at?: number;
}

// ─── Versions ──────────────────────────────────────────────────────

/** Also what makes a registry or file value safe to print on a terminal. */
export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * True when `latest` is newer than `current`. A prerelease sorts before its release; two
 * prereleases of one release count as equal, since npm's `latest` tag only ever holds releases.
 */
export function isBehind(current: string, latest: string): boolean {
  if (!isVersion(current) || !isVersion(latest)) return false;
  const parse = (v: string) => {
    const [core, pre] = v.split(/-(.*)/s);
    return { parts: core.split(".").map(Number), pre: pre ?? "" };
  };
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i];
  }
  return a.pre !== "" && b.pre === "";
}

// ─── Registry ──────────────────────────────────────────────────────

function registryBase(env: Env): string {
  const configured = env.npm_config_registry?.trim();
  return (configured && /^https?:\/\//.test(configured) ? configured : DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/** The latest published version. Throws when the registry cannot say. */
export async function fetchLatestVersion(options: { timeoutMs: number; env?: Env }): Promise<string> {
  const response = await fetch(`${registryBase(options.env ?? process.env)}/@ideaspaces/cli/latest`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`the npm registry answered ${response.status}`);
  }
  const version = ((await response.json()) as { version?: unknown }).version;
  if (!isVersion(version)) throw new Error("the npm registry gave no usable version");
  return version;
}

// ─── State ─────────────────────────────────────────────────────────

function stateFile(): string {
  return join(configDir(), "update-check.json");
}

export function readUpdateState(): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    const state: UpdateState = {};
    if (typeof raw.checked_at === "number") state.checked_at = raw.checked_at;
    if (isVersion(raw.latest)) state.latest = raw.latest;
    if (typeof raw.notified_at === "number") state.notified_at = raw.notified_at;
    return state;
  } catch {
    return {};
  }
}

function writeUpdateState(state: UpdateState): void {
  const file = stateFile();
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* nothing to clean */ }
    throw err;
  }
}

function olderThanADay(at: number | undefined, now: number): boolean {
  return at === undefined || at > now || now - at >= DAY_MS;
}

// ─── When the CLI may look ─────────────────────────────────────────

function envTrue(value: string | undefined): boolean {
  return !!value && !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function updateCheckOptedOut(env: Env): boolean {
  return envTrue(env.IDEASPACES_NO_UPDATE_CHECK) || envTrue(env.NO_UPDATE_NOTIFIER);
}

/** The CLI contacts the registry on its own only when this holds. An explicit `upgrade` always may. */
export function mayCheckForUpdates(env: Env = process.env): boolean {
  if (updateCheckOptedOut(env) || envTrue(env.CI)) return false;
  // The app owns its CLI, and host mode promises it leaves the terminal's ~/.ideaspaces alone.
  return env.IDEASPACES_AUTH !== "host";
}

export interface NoticeContext {
  command: string;
  json: boolean;
  quiet: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  env: Env;
  install: Install;
}

/**
 * Both streams must be terminals: a pipe on either side means something other than a person may
 * be reading. A pseudo-terminal under an agent is why the agent markers are read too.
 */
export function noticeAllowed(context: NoticeContext): boolean {
  return (
    mayCheckForUpdates(context.env) &&
    !context.json &&
    !context.quiet &&
    context.stdoutTTY &&
    context.stderrTTY &&
    !context.env.AI_AGENT &&
    !context.env.CLAUDECODE &&
    NOTICE_KINDS.has(context.install.kind) &&
    !NO_NOTICE_COMMANDS.has(context.command)
  );
}

// ─── The notice ────────────────────────────────────────────────────

export function noticeLine(latest: string, install: Install, current: string = CLI_VERSION): string {
  return `ideaspaces ${latest} is available (you have ${current}). ${updateAdvice(install).text}`;
}

/** The refresh, in a detached child that outlives this command. Called `__update-check`. */
export async function refreshUpdateState(): Promise<void> {
  const latest = await fetchLatestVersion({ timeoutMs: 5000 });
  writeUpdateState({ ...readUpdateState(), latest });
}

function startRefresh(): void {
  const child = spawn(process.execPath, [selfPath(), UPDATE_CHECK_COMMAND], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

/** One step after a command, for a person at a terminal. Never throws and never waits. */
export function afterCommand(
  context: Pick<NoticeContext, "command" | "json" | "quiet">,
  runtime: {
    now?: number;
    env?: Env;
    stdoutTTY?: boolean;
    stderrTTY?: boolean;
    install?: Install;
    refresh?: () => void;
    write?: (line: string) => void;
    current?: string;
  } = {},
): void {
  try {
    const env = runtime.env ?? process.env;
    if (!mayCheckForUpdates(env)) return;
    const install = runtime.install ?? detectInstall();
    const allowed = noticeAllowed({
      ...context,
      env,
      stdoutTTY: runtime.stdoutTTY ?? Boolean(process.stdout.isTTY),
      stderrTTY: runtime.stderrTTY ?? Boolean(process.stderr.isTTY),
      install,
    });
    if (!allowed) return;

    const now = runtime.now ?? Date.now();
    const state = readUpdateState();
    const next = { ...state };
    const refreshDue = olderThanADay(state.checked_at, now);
    if (refreshDue) next.checked_at = now;

    const current = runtime.current ?? CLI_VERSION;
    const announce = state.latest !== undefined && isBehind(current, state.latest) && olderThanADay(state.notified_at, now);
    if (announce) next.notified_at = now;

    if (refreshDue || announce) writeUpdateState(next);
    if (refreshDue) (runtime.refresh ?? startRefresh)();
    if (announce) (runtime.write ?? ((line) => process.stderr.write(line + "\n")))(noticeLine(state.latest!, install, current));
  } catch {
    // A notice is never worth a failed command.
  }
}

// ─── What the last check found ─────────────────────────────────────

/**
 * The newest version known without any network call. Errors and `status doctor` only ever read
 * this: the daily check is the one lookup the CLI makes on its own, and `upgrade` is the one a
 * person asks for.
 */
export function knownLatest(): string | null {
  if (isHostAuth()) return null;
  return readUpdateState().latest ?? null;
}

/** As `knownLatest`, but null when it could only say "current" from an old check. */
export function knownLatestForCompare(current: string = CLI_VERSION, now: number = Date.now()): string | null {
  if (!mayCheckForUpdates()) return null;
  const { latest, checked_at: checkedAt } = readUpdateState();
  if (!latest) return null;
  const fresh = checkedAt !== undefined && checkedAt <= now && now - checkedAt < 7 * DAY_MS;
  return fresh || isBehind(current, latest) ? latest : null;
}

/**
 * "What you have, what is needed, what to run." The latest comes from the last check and may be
 * old, so it can say a newer version exists but never that none does: `upgrade` asks the registry.
 */
export function outOfDateMessage(
  latest: string | null = knownLatest(),
  install: Install = detectInstall(),
  current: string = CLI_VERSION,
): string {
  const need = latest && isBehind(current, latest) ? `the latest is ${latest}` : "this service needs a newer one";
  return `This CLI is out of date: you have ${current}, and ${need}.\n${updateAdvice(install).text}`;
}
