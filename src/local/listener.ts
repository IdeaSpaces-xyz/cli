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
  source: string; // real local Thread directory
  sourcePostId: string; // its opening post, not a mutable folder name
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
export type Summarize = (record: ListenerRecord, source: { id: string; body: string }, runId: string) => Promise<string>;

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
  if (record.version !== 1 || record.id !== thread.thread_id || record.source !== thread.path ||
    record.sourcePostId !== thread.thread_id || record.destinationPostId !== thread.thread_id ||
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
  const record: ListenerRecord = { version: 1, id: thread.thread_id, source: thread.path,
    sourcePostId: thread.thread_id, signal: "new-post", pov, task, model,
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
function provenance(record: ListenerRecord, source: string, run: string): string[] {
  return [`listener:${record.id}`, `source:${source}`, `run:${run}`];
}
function outputs(thread: LocalThread, tags: string[]): string[] {
  return thread.posts.filter((p) => tags.every((t) => p.frontmatter.tags?.includes(t))).map((p) => p.id);
}
function saveRuns(path: string, runs: ListenerRun[]): void { atomic(path, runs); }
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // One watcher/tick per listener. A dead process leaves a stale lock; on restart
  // reconcile every writing/running record before another model invocation.
  if (existsSync(path)) {
    if (!regular(path)) throw new Error("Unsafe listener lock; inspect it before continuing.");
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid listener lock; inspect it before continuing.");
    try { process.kill(pid, 0); throw new Error(`Listener already runs in process ${pid}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    unlinkSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return fn().finally(() => { if (regular(path) && readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); });
}
/** One scan. The outer watch process calls this repeatedly; startup always scans all posts. */
export function reconcileListener(threadPath: string, summarize: Summarize): Promise<ListenerRun[]> {
  const initial = loadThread(threadPath);
  const state = paths(initial);
  return withLock(state.lock, async () => {
    const runs = existsSync(state.ledger) ? json<ListenerRun[]>(state.ledger) : [];
    // Any interrupted run is not retried. A proven post is recovered by provenance;
    // an absent post after an interrupted append cannot prove the write failed.
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "writing") continue;
      const tags = provenance({ id: initial.thread_id! } as ListenerRecord, run.sourcePostId, run.runId);
      const found = outputs(loadThread(threadPath), tags);
      if (found.length === 1) { run.status = "posted"; run.outputPostId = found[0]; }
      else { run.status = "uncertain"; run.reason = found.length ? "Multiple outputs for one input; inspect the Thread." : "Run interrupted; inspect before retry."; }
    }
    saveRuns(state.ledger, runs);
    const grant = existsSync(state.grant) ? json<ListenerGrant>(state.grant) : undefined;
    let record: ListenerRecord;
    try { record = listenerRecord(threadPath); } catch { return runs; }
    if (!grant?.enabled || grant.revision !== revision(record)) return runs;
    const thread = loadThread(threadPath);
    for (const post of thread.posts) {
      // Our output is a snapshot bearing stable provenance, not an ordinary source post.
      // A user's ordinary post cannot suppress intake by copying its tags.
      if (post.kind !== "post" || post.id === thread.thread_id || grant.baseline.includes(post.id)) continue;
      const key = `${record.id}/${grant.revision}/${post.id}`;
      if (runs.some((run) => run.key === key)) continue;
      const run: ListenerRun = { key, sourcePostId: post.id, revision: grant.revision, runId: randomUUID(), status: "running" };
      runs.push(run); saveRuns(state.ledger, runs);
      let body: string;
      try { body = await summarize(record, { id: post.id, body: post.body }, run.runId); }
      catch (error) { run.status = "failed"; run.reason = `Agent failed: ${String(error)}`; saveRuns(state.ledger, runs); continue; }
      if (!body.trim()) { run.status = "failed"; run.reason = "Agent returned no summary."; saveRuns(state.ledger, runs); continue; }
      run.status = "writing"; saveRuns(state.ledger, runs);
      const tags = provenance(record, post.id, run.runId);
      try {
        const { post: output } = appendPost(threadPath, {
          body, author: record.pov, kind: "snapshot", replyTo: [post.id], tags,
          name: `Summary — ${record.pov}`,
          verifyTarget(current, parents) {
            const live = json<ListenerGrant>(state.grant);
            const checked = listenerRecord(current.path);
            if (!live.enabled || live.revision !== run.revision || revision(checked) !== run.revision ||
                checked.destinationPostId !== current.thread_id || checked.sourcePostId !== current.thread_id ||
                parents.length !== 1 || parents[0] !== post.id ||
                !current.posts.some((p) => p.id === post.id && p.kind === "post") || outputs(current, tags).length) {
              throw new Error("Listener grant, source or destination changed; guarded append refused.");
            }
          },
        });
        run.status = "posted"; run.outputPostId = output.id;
      } catch (error) {
        // appendPost can throw after an exclusive create. Never assume no write.
        const found = outputs(loadThread(threadPath), tags);
        if (found.length === 1) { run.status = "posted"; run.outputPostId = found[0]; }
        else { run.status = "uncertain"; run.reason = `Append outcome requires inspection: ${String(error)}`; }
      }
      saveRuns(state.ledger, runs);
    }
    return runs;
  });
}
