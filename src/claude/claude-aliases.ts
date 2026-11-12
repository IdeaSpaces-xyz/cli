/**
 * Which model each of Claude Code's aliases means on this binary, as the binary
 * says it. Claude Code has no `models` listing command, but every headless run
 * opens with a `system/init` record that names the model it resolved for
 * `--model <alias>`. That record is written before any prompt is handled, so
 * the probe reads it and stops the process there: no model call, no usage, no
 * saved session. Verified on Claude Code 2.1.322 (2026-11-12): `fable` reported
 * `claude-fable-5-2`, `opusplan` its executor `claude-sonnet-5-5`, and a name
 * that is not an alias came back unchanged.
 *
 * The prompt is `/cost`, a local command that makes no model call, so even a
 * process that outlives the stop spends nothing.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCommand } from "../local/runtime-command.js";
import { reportedModel } from "../local/send-options.js";

/**
 * Claude Code's own alias words: the default (no `--model`), then the aliases
 * `--model` documents. Only the words are typed here; what each one means comes
 * from the binary, and an alias it does not resolve is not listed.
 */
export const CLAUDE_ALIASES: readonly string[] = ["", "opus", "sonnet", "haiku", "fable", "opusplan"];

/** How long one alias may take to reach `init`. All of them run at once. */
export const ALIAS_PROBE_TIMEOUT_MS = 8_000;

export interface ResolvedAlias {
  /** The alias asked for ("" for no `--model`). */
  ref: string;
  /** The model Claude Code reported in `init`, or null when it reported none. */
  model: string | null;
  /** Why there is no model, in words a person can act on. */
  detail?: string;
}

/** The arguments of one probe: a headless run that loads nothing of the person's setup. */
export function aliasProbeArgs(ref: string): string[] {
  return [
    "-p",
    ...(ref ? ["--model", ref] : []),
    "--output-format", "stream-json", "--verbose",
    "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/** The model an alias resolved to, or null when the binary echoed the alias back (it does not know it). */
export function resolvedModel(ref: string, model: string | null): string | null {
  if (!model || model === "<synthetic>") return null;
  if (ref && model === ref) return null;
  return model;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function resolveOne(bin: string, ref: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ResolvedAlias> {
  return new Promise((done) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const label = ref ? `--model ${ref}` : "the default model";
    const finish = (result: ResolvedAlias) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      done(result);
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const command = runtimeCommand(bin, aliasProbeArgs(ref), env, cwd);
      child = spawn(command.command, command.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish({ ref, model: null, detail: `could not start Claude Code for ${label}: ${String((error as Error)?.message ?? error)}` });
      return;
    }
    timer = setTimeout(() => finish({ ref, model: null, detail: `Claude Code did not name a model for ${label} within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    child.on("error", (error) => finish({ ref, model: null, detail: `could not start Claude Code for ${label}: ${error.message}` }));
    child.stderr?.on("data", (d) => { if (stderr.length < 4096) stderr += String(d); });
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      let at: number;
      while ((at = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, at);
        stdout = stdout.slice(at + 1);
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.type === "system" && record.subtype === "init") {
          const model = resolvedModel(ref, reportedModel(record.model));
          finish(model ? { ref, model } : { ref, model: null, detail: `Claude Code does not resolve ${label}` });
          return;
        }
        // Anything else first is not a run that started: say what it was.
        const said = typeof record?.result === "string" ? firstLine(record.result) : "";
        finish({ ref, model: null, detail: `Claude Code answered ${label} without naming a model${said ? `: ${said}` : ""}` });
        return;
      }
    });
    child.on("close", (code) => {
      const said = firstLine(stderr);
      finish({ ref, model: null, detail: `Claude Code exited (${code ?? "signal"}) before naming a model for ${label}${said ? `: ${said}` : ""}` });
    });
    child.stdin?.on("error", () => { /* the process may stop before reading its prompt */ });
    child.stdin?.end("/cost\n");
  });
}

/**
 * Ask the binary what each alias means, all at once. The working directory is an
 * empty temporary folder, so no project's settings or `CLAUDE.md` are read.
 */
export async function resolveClaudeAliases(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { refs?: readonly string[]; timeoutMs?: number } = {},
): Promise<ResolvedAlias[]> {
  const cwd = mkdtempSync(join(tmpdir(), "ideaspaces-claude-aliases-"));
  try {
    return await Promise.all((options.refs ?? CLAUDE_ALIASES).map((ref) =>
      resolveOne(bin, ref, env, cwd, options.timeoutMs ?? ALIAS_PROBE_TIMEOUT_MS)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
