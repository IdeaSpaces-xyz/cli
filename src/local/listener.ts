/* One local Thread listener. The model never receives a filesystem, network or post tool;
 * the host reads its source post and calls the existing Thread writer itself. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendPost, loadThread, type LocalThread } from "./threads.js";

export interface ListenerRecord {
  version: 1;
  id: string;
  sourceThreadId: string; // opening post id; portable across clones and folder moves
  signal: "new-post";
  pov: string;
  task: string;
  model: string;
  capabilities: ["thread-read", "thread-post"];
  destinationPostId: string; // same Thread, identified by opening post
}
export interface ListenerGrant { enabled: boolean; revision: string; baseline: string[] }
export interface ListenerRun {
  key: string; sourcePostId: string; revision: string; runId: string;
  status: "running" | "writing" | "posted" | "failed" | "uncertain";
  outputPostId?: string; reason?: string;
}
export type Summarize = (record: ListenerRecord, source: { id: string; body: string; threadPath: string }, runId: string, signal?: AbortSignal) => Promise<string>;

class ListenerGuardRefusal extends Error {}

function regular(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
}
function json<T>(path: string): T {
  if (!regular(path)) throw new Error(`Missing or unsafe listener file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink() || (existsSync(path) && !regular(path))) throw new Error(`Unsafe listener state path: ${path}`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
}
function paths(thread: LocalThread) {
  if (!thread.thread_id || !/^msg_[0-9a-f-]{36}$/.test(thread.thread_id)) throw new Error("Listener needs a Thread with a stable opening post id.");
  const space = dirname(dirname(thread.path));
  const key = createHash("sha256").update(`${realpathSync(space)}\0${thread.thread_id}`).digest("hex");
  const dir = join(homedir(), ".ideaspaces", "listeners", key);
  return { record: join(space, "_agent", "listeners", `${thread.thread_id}.json`), grant: join(dir, "grant.json"), ledger: join(dir, "ledger.json"), lock: join(dir, "run.lock") };
}
function revision(record: ListenerRecord): string { return createHash("sha256").update(JSON.stringify(record)).digest("hex"); }
function validate(thread: LocalThread, record: ListenerRecord): void {
  if (record.version !== 1 || record.id !== thread.thread_id || record.sourceThreadId !== thread.thread_id ||
    record.destinationPostId !== thread.thread_id ||
    record.signal !== "new-post" || !record.task?.trim() || !record.pov?.trim() || !record.model?.trim() ||
    JSON.stringify(record.capabilities) !== JSON.stringify(["thread-read", "thread-post"])) {
    throw new Error("Listener record must bind this local Thread, same-Thread destination, task, POV and read/post-only capabilities.");
  }
}
export function listenerRecord(threadPath: string): ListenerRecord {
  const thread = loadThread(threadPath);
  const record = json<ListenerRecord>(paths(thread).record);
  validate(thread, record);
  return record;
}
export function createListener(threadPath: string, pov: string, task: string, model = "haiku"): string {
  const thread = loadThread(threadPath);
  if (!thread.thread_id) throw new Error("Thread needs an opening post id.");
  const record: ListenerRecord = { version: 1, id: thread.thread_id, sourceThreadId: thread.thread_id,
    signal: "new-post", pov, task, model,
    capabilities: ["thread-read", "thread-post"], destinationPostId: thread.thread_id };
  validate(thread, record);
  const target = paths(thread).record;
  if (existsSync(target)) throw new Error(`Listener already exists: ${target}. Edit its task, then explicitly enable the new revision.`);
  atomic(target, record);
  return target;
}
export function setListenerEnabled(threadPath: string, enabled: boolean): ListenerGrant {
  const thread = loadThread(threadPath);
  const path = paths(thread).grant;
  if (!enabled) {
    const current = existsSync(path) ? json<ListenerGrant>(path) : { revision: "", baseline: [] };
    const grant = { ...current, enabled: false }; atomic(path, grant); return grant;
  }
  const record = listenerRecord(thread.path);
  // A new approval starts at the present head, not at every historical post.
  const grant = { enabled: true, revision: revision(record), baseline: thread.posts.map((p) => p.id) };
  atomic(path, grant);
  return grant;
}
export function listenerStatus(threadPath: string) {
  const thread = loadThread(threadPath);
  const state = paths(thread);
  const grant = existsSync(state.grant) ? json<ListenerGrant>(state.grant) : undefined;
  const ledger = existsSync(state.ledger) ? json<ListenerRun[]>(state.ledger) : [];
  let reviewed = false;
  try { reviewed = !!grant?.enabled && grant.revision === revision(listenerRecord(thread.path)); } catch { /* edited/invalid record cannot run */ }
  return { record: state.record, enabled: !!grant?.enabled, reviewed, runs: ledger };
}
function provenance(listenerId: string, source: string, run: string): string[] {
  return [`listener:${listenerId}`, `source:${source}`, `run:${run}`];
}
function outputs(thread: LocalThread, tags: string[]): string[] {
  return thread.posts.filter((p) => tags.every((t) => p.frontmatter.tags?.includes(t))).map((p) => p.id);
}
function saveRuns(path: string, runs: ListenerRun[]): void { atomic(path, runs); }
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Serialize *acquisition* too: without this gate two starters could both see
  // a dead PID and one could unlink the other's freshly acquired run lock.
  const gate = `${path}.gate`;
  let gateFd: number;
  try { gateFd = openSync(gate, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Listener lock acquisition blocked by ${gate}; verify no watcher/tick runs, then remove this stale gate manually.`);
    throw error;
  }
  try {
    // A dead process leaves a stale run lock; reconcile its ledger on restart.
    // A crash *while acquiring* leaves the gate, requiring manual inspection.
    if (existsSync(path)) {
      if (!regular(path)) throw new Error(`Unsafe listener lock ${path}; inspect it before continuing.`);
      const pid = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid listener lock ${path}; inspect it before continuing.`);
      try { process.kill(pid, 0); throw new Error(`Listener already runs in process ${pid} (${path}).`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") throw new Error(`Cannot verify listener lock process ${pid}; inspect before continuing.`);
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(path);
    }
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Listener already runs or another runner claimed ${path}; inspect before continuing.`);
      throw error;
    }
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } finally { closeSync(gateFd); unlinkSync(gate); }
  return fn().finally(() => { if (regular(path) && readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); });
}
/** Person-inspected resolution of an ambiguous append, without a blind retry.
 * Stop the watcher first. `none` records a checked absence; only a proven
 * provenance/reply-linked post can be acknowledged as written. */
export function resolveListenerRun(threadPath: string, sourcePostId: string, outputPostId: string | "none"): Promise<ListenerRun> {
  const thread = loadThread(threadPath);
  const state = paths(thread);
  return withLock(state.lock, async () => {
    if (!existsSync(state.ledger)) throw new Error("No listener runs recorded; there is nothing to resolve.");
    const runs = json<ListenerRun[]>(state.ledger);
    const run = runs.find((item) => item.sourcePostId === sourcePostId && item.status === "uncertain");
    if (!run) throw new Error(`No uncertain listener run for ${sourcePostId}.`);
    const tags = provenance(thread.thread_id!, run.sourcePostId, run.runId);
    const current = loadThread(threadPath);
    const found = outputs(current, tags);
    if (outputPostId === "none") {
      if (found.length) throw new Error("An output with this run's provenance exists; inspect and resolve with its post id.");
      run.status = "failed"; run.reason = "Person inspected the Thread; no output confirmed. No automatic retry.";
    } else {
      const post = current.posts.find((item) => item.id === outputPostId);
      if (found.length !== 1 || found[0] !== outputPostId || !post?.inReplyTo.includes(sourcePostId)) {
        throw new Error("Output is not a unique reply with this run's listener/source/run provenance.");
      }
      run.status = "posted"; run.outputPostId = post.id; delete run.reason;
    }
    saveRuns(state.ledger, runs);
    return run;
  });
}

/** Hold the exclusive run lock for a watcher's entire lifetime, not just each poll. */
export function withListenerWatch<T>(threadPath: string, run: () => Promise<T>): Promise<T> {
  return withLock(paths(loadThread(threadPath)).lock, run);
}

/** One scan. The watcher holds the lock across polls; tick acquires it per scan. */
export function reconcileListener(threadPath: string, summarize: Summarize, watchLocked = false, signal?: AbortSignal): Promise<ListenerRun[]> {
  const initial = loadThread(threadPath);
  const state = paths(initial);
  const scan = async () => {
    const runs = existsSync(state.ledger) ? json<ListenerRun[]>(state.ledger) : [];
    // Any interrupted run is not retried. A proven post is recovered by provenance;
    // an absent post after an interrupted append cannot prove the write failed.
    let recovered = false;
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "writing") continue;
      recovered = true;
      const tags = provenance(initial.thread_id!, run.sourcePostId, run.runId);
      const found = outputs(loadThread(threadPath), tags);
      if (found.length === 1) { run.status = "posted"; run.outputPostId = found[0]; }
      else { run.status = "uncertain"; run.reason = found.length ? "Multiple outputs for one input; inspect the Thread." : "Run interrupted; inspect before retry."; }
    }
    if (recovered) saveRuns(state.ledger, runs);
    const grant = existsSync(state.grant) ? json<ListenerGrant>(state.grant) : undefined;
    let record: ListenerRecord;
    try { record = listenerRecord(threadPath); } catch { return runs; }
    if (!grant?.enabled || grant.revision !== revision(record)) return runs;
    const thread = loadThread(threadPath);
    for (const post of thread.posts) {
      if (signal?.aborted) break;
      // Our output is a snapshot bearing stable provenance, not an ordinary source post.
      // A user's ordinary post cannot suppress intake by copying its tags.
      if (post.kind !== "post" || post.id === thread.thread_id || grant.baseline.includes(post.id)) continue;
      const key = `${record.id}/${grant.revision}/${post.id}`;
      if (runs.some((run) => run.key === key)) continue;
      const run: ListenerRun = { key, sourcePostId: post.id, revision: grant.revision, runId: randomUUID(), status: "running" };
      runs.push(run); saveRuns(state.ledger, runs);
      let body: string;
      try { body = await summarize(record, { id: post.id, body: post.body, threadPath: thread.path }, run.runId, signal); }
      catch (error) { run.status = "failed"; run.reason = `Agent failed: ${String(error)}`; saveRuns(state.ledger, runs); continue; }
      if (!body.trim()) { run.status = "failed"; run.reason = "Agent returned no summary."; saveRuns(state.ledger, runs); continue; }
      run.status = "writing"; saveRuns(state.ledger, runs);
      const tags = provenance(record.id, post.id, run.runId);
      try {
        const { post: output } = appendPost(threadPath, {
          body, author: record.pov, kind: "snapshot", replyTo: [post.id], tags,
          name: `Summary — ${record.pov}`,
          verifyTarget(current, parents) {
            const live = json<ListenerGrant>(state.grant);
            const checked = listenerRecord(current.path);
            if (!live.enabled || live.revision !== run.revision || revision(checked) !== run.revision ||
                checked.destinationPostId !== current.thread_id || checked.sourceThreadId !== current.thread_id ||
                parents.length !== 1 || parents[0] !== post.id ||
                !current.posts.some((p) => p.id === post.id && p.kind === "post") || outputs(current, tags).length) {
              throw new ListenerGuardRefusal("Listener grant, source or destination changed; guarded append refused before writing.");
            }
          },
        });
        run.status = "posted"; run.outputPostId = output.id;
      } catch (error) {
        // A known pre-write refusal is a failure, not an ambiguous write.
        if (error instanceof ListenerGuardRefusal) {
          run.status = "failed"; run.reason = error.message;
        } else {
          // appendPost can throw after an exclusive create. Never assume no write.
          const found = outputs(loadThread(threadPath), tags);
          if (found.length === 1) { run.status = "posted"; run.outputPostId = found[0]; }
          else { run.status = "uncertain"; run.reason = `Append outcome requires inspection: ${String(error)}`; }
        }
      }
      saveRuns(state.ledger, runs);
    }
    return runs;
  };
  return watchLocked ? scan() : withLock(state.lock, scan);
}
