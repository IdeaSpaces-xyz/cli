import { resolveLocalThread } from "../local/threads.js";
import { createListener, listenerRecord, listenerStatus, reconcileListener, resolveListenerRun, setListenerEnabled, withListenerWatch, type Summarize } from "../local/listener.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const USAGE = "ideaspaces listener <create|enable|disable|status|tick|watch|resolve> <local-Thread> [--pov <name> --task <text> --model <Claude model>] [--interval <ms>] [--source <post-id> --output <post-id|none>]";
const text = (flags: Record<string, string | boolean>, key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;

/** Non-UI local operation. Desktop may spawn `watch`; no window-focus refresh is involved. */
export const makeListenerCommand = (summarizeThreadPost: Summarize): CommandDef => ({
  name: "listener",
  description: "One enabled local Thread-post summarizer, with a restricted model and guarded same-Thread writer. Run watch independently of the Desktop window.",
  usage: USAGE,
  examples: ["ideaspaces listener create _threads/topic --pov Summarizer --task 'Summarize new posts'", "ideaspaces listener enable _threads/topic", "ideaspaces listener watch _threads/topic", "ideaspaces listener status _threads/topic --json"],
  async run(args, flags, global) {
    const output = createOutput(global);
    const [verb, target] = args;
    if (!target || args.length !== 2) { output.error(USAGE); return 1; }
    try {
      const thread = resolveLocalThread(target, global.repo ?? process.cwd());
      if (verb === "create") {
        const pov = text(flags, "pov"), task = text(flags, "task");
        if (!pov || !task) throw new Error("Create needs --pov <name> and --task <text>.");
        const path = createListener(thread, pov, task, text(flags, "model") ?? "haiku");
        output.result({ path, enabled: false }, `Listener record: ${path}. Review it, then explicitly enable.`); return 0;
      }
      if (verb === "enable" || verb === "disable") {
        const grant = setListenerEnabled(thread, verb === "enable");
        const record = verb === "enable" ? listenerRecord(thread) : undefined;
        output.result({ grant, ...(record ? { record } : {}) }, verb === "enable"
          ? `Enabled revision ${grant.revision} for ${record!.pov} (${record!.model}): ${record!.task}\nSource/destination: ${record!.sourceThreadId}; capabilities: ${record!.capabilities.join(", ")}. Baseline: ${grant.baseline.length} existing posts.`
          : "Listener disabled."); return 0;
      }
      if (verb === "status") {
        const status = listenerStatus(thread);
        output.result(status, `Listener ${status.enabled ? (status.reviewed ? "enabled" : "changed; run listener enable after review") : "disabled"}; ${status.runs.length} run(s).\n${status.runs.map((run) => `${run.sourcePostId}: ${run.status}${run.outputPostId ? ` → ${run.outputPostId}` : run.reason ? `: ${run.reason}` : ""}`).join("\n")}`); return 0;
      }
      if (verb === "resolve") {
        const source = text(flags, "source"), result = text(flags, "output");
        if (!source || !result) throw new Error("Resolve needs --source <post-id> --output <post-id|none>. Stop the watcher and inspect the Thread first.");
        const run = await resolveListenerRun(thread, source, result);
        output.result(run, `${source}: ${run.status}${run.outputPostId ? ` → ${run.outputPostId}` : `: ${run.reason}`}`); return 0;
      }
      if (verb !== "tick" && verb !== "watch") throw new Error(USAGE);
      const interval = flags.interval === undefined ? 1000 : Number(text(flags, "interval"));
      if (!Number.isSafeInteger(interval) || interval < 100) throw new Error("--interval must be an integer >= 100ms.");
      let stopping = false, warnedRevision = false;
      const controller = new AbortController();
      const stop = () => {
        if (stopping) process.exit(130); // A second signal forces exit; restart reconciles the ledger.
        stopping = true;
        controller.abort(); // Stops an in-flight Claude child and wakes the poll sleep.
      };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      try {
        const iterate = async () => {
          do {
            const state = listenerStatus(thread);
            if (state.enabled && !state.reviewed && !warnedRevision) {
              output.log("Listener record changed; review it and run listener enable to approve a new revision.");
              warnedRevision = true;
            }
            if (state.reviewed) warnedRevision = false;
            const before = new Map(state.runs.map((run) => [run.key, run.status]));
            const runs = await reconcileListener(thread, summarizeThreadPost, verb === "watch", controller.signal);
            const changed = runs.filter((run) => before.get(run.key) !== run.status);
            for (const run of changed) output.log(`${run.sourcePostId}: ${run.status}${run.outputPostId ? ` → ${run.outputPostId}` : run.reason ? `: ${run.reason}` : ""}`);
            if (verb === "tick") {
              output.result({ runs }, `${runs.length} run(s).\n${runs.map((run) => `${run.sourcePostId}: ${run.status}${run.outputPostId ? ` → ${run.outputPostId}` : run.reason ? `: ${run.reason}` : ""}`).join("\n")}`);
              return 0;
            }
            if (stopping) break;
            await new Promise<void>((resolve) => {
              const wake = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", wake); resolve(); };
              const timer = setTimeout(wake, interval);
              controller.signal.addEventListener("abort", wake, { once: true });
            });
          } while (!stopping);
          return 0;
        };
        return verb === "watch" ? await withListenerWatch(thread, iterate) : await iterate();
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error)); return 1;
    }
  },
});
