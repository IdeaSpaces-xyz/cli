// `ideaspaces pi-models --json` — the models a local Pi turn can use, for a
// desktop model picker.
//
// pi's `--list-models` is table-only, so we use its rpc protocol instead: spawn
// `pi --mode rpc`, send one `get_available_models` command, read the response,
// exit. The list is auth-gated by pi (`modelRegistry.getAvailable()` → only
// providers with credentials in ~/.pi/agent/auth.json), so the picker shows
// exactly what's runnable. Selection is unchanged — the caller passes the chosen
// `ref` as `--model` to `conversation send --local`.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

/** A model trimmed to what a picker needs. `ref` is the unambiguous
 *  `provider/id` to hand back as `--model`. */
export interface PiModel {
  ref: string;
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  /** Supports extended thinking/reasoning. */
  reasoning: boolean;
  /** Accepts image input. */
  image: boolean;
  cost?: { input: number; output: number };
}

/** pi's raw `Model` (the fields we read; see pi-ai types.ts). */
interface RawModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number };
}

/** Pure trim — testable without spawning pi. */
export function trimModel(m: RawModel): PiModel {
  return {
    ref: `${m.provider}/${m.id}`,
    id: m.id,
    name: m.name ?? m.id,
    provider: m.provider,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    reasoning: !!m.reasoning,
    image: (m.input ?? []).includes("image"),
    cost: m.cost ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } : undefined,
  };
}

export interface PiModelsResult {
  models: PiModel[];
}

const QUERY_ID = "__models";
const TIMEOUT_MS = 20_000;

/** One-shot rpc `get_available_models`. Resolves the trimmed list, or rejects on
 *  pi exit / timeout / no response. */
export function queryPiModels(piBin: string): Promise<PiModelsResult> {
  return new Promise((resolve, reject) => {
    // No extensions/skills: model listing only needs the registry + auth, and
    // `--no-extensions` avoids loading (and conflicting on) globally-installed
    // extensions during the query.
    const pi = spawn(piBin, ["--mode", "rpc", "--no-extensions"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pi.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error("pi did not return models within the timeout"))),
      TIMEOUT_MS,
    );

    pi.stderr.on("data", (d) => {
      stderr += String(d);
    });
    pi.on("error", (err) =>
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("pi not found — check the runtime with `ideaspaces pi-status`")
            : err,
        ),
      ),
    );
    pi.on("exit", (code) => {
      if (settled) return;
      finish(() =>
        reject(new Error(stderr.trim() || `pi exited (${code ?? "unknown"}) before returning models`)),
      );
    });

    const rl = createInterface({ input: pi.stdout, terminal: false });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // pi emits only JSON lines; ignore stray output
      }
      if (msg.type === "response" && msg.command === "get_available_models") {
        if (msg.success === false) {
          finish(() => reject(new Error(String(msg.error ?? "get_available_models failed"))));
          return;
        }
        const data = msg.data as { models?: RawModel[] } | undefined;
        const models = (data?.models ?? []).map(trimModel);
        finish(() => resolve({ models }));
      }
    });

    // Buffered on stdin; pi processes it once the session is up.
    try {
      pi.stdin.write(`${JSON.stringify({ type: "get_available_models", id: QUERY_ID })}\n`);
    } catch {
      finish(() => reject(new Error("could not send the query to pi")));
    }
  });
}

function formatHuman(result: PiModelsResult): string {
  if (!result.models.length) return "No models available — configure a provider (see `pi-status`).";
  return result.models
    .map((m) => {
      const tags = [m.reasoning ? "thinking" : null, m.image ? "images" : null].filter(Boolean).join(", ");
      return `${m.ref}${m.name !== m.id ? `  (${m.name})` : ""}${tags ? `  · ${tags}` : ""}`;
    })
    .join("\n");
}

export const piModelsCommand: CommandDef = {
  name: "pi-models",
  description: "List the models a local Pi turn can use (auth-gated), for a model picker.",
  usage: "ideaspaces pi-models [--pi-bin <path>] [--json]",
  examples: ["ideaspaces pi-models --json", "ideaspaces pi-models  # human-readable"],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const piBin = typeof flags["pi-bin"] === "string" ? flags["pi-bin"] : "pi";
    try {
      const result = await queryPiModels(piBin);
      output.result(result, formatHuman(result));
      return 0;
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  },
};
