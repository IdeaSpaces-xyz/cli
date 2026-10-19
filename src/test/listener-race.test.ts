import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendPost, createThread, loadThread } from "../local/threads.js";
import { createListener, setListenerEnabled } from "../local/listener.js";

const worker = fileURLToPath(new URL("./fixtures/listener-race-worker.mjs", import.meta.url));
const children: ChildProcess[] = [];
const roots: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "listener-race-")); roots.push(root); process.env.HOME = root;
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent", "agreement.md"), "---\nname: Fixture\n---\n");
  const thread = createThread("topic", "A topic", root).path;
  appendPost(thread, { body: "Opening" });
  const record = createListener(thread, "Summarizer", "Original task");
  setListenerEnabled(thread, true);
  return { root, thread, record };
}
function start(mode: string, thread: string, barrier: string, root: string): ChildProcess {
  const child = spawn(process.execPath, [worker, mode, thread, barrier], { env: { ...process.env, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}
async function until(path: string) {
  for (let i = 0; i < 400; i++) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
async function ended(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker ${child.pid} did not exit`)), 9000);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child.once("error", reject);
  });
}
function result(barrier: string) {
  if (existsSync(`${barrier}.error`)) throw new Error(readFileSync(`${barrier}.error`, "utf8"));
  return JSON.parse(readFileSync(`${barrier}.done`, "utf8"));
}
function edit(record: string) {
  const value = JSON.parse(readFileSync(record, "utf8"));
  writeFileSync(record, JSON.stringify({ ...value, task: `Edited ${Date.now()}` }));
}

describe("listener cooperative process revocation", () => {
  it("append verified before wx wins; disable and re-enable block until creation", async () => {
    const { root, thread, record } = fixture();
    for (const mode of ["disable", "enable"]) {
      const source = appendPost(thread, { body: `Input ${mode}` }).post;
      const barrier = join(root, `append-first-${mode}`);
      const append = start("append", thread, barrier, root);
      await until(`${barrier}.verified`); // actual writer has checked live grant and Thread, lock held
      const grantBarrier = `${barrier}-grant`;
      const grant = start(mode, thread, grantBarrier, root);
      await until(`${grantBarrier}.started`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(`${grantBarrier}.done`)).toBe(false); // grant cannot replace until wx completes
      writeFileSync(`${barrier}.release`, "go");
      await until(`${barrier}.done`);
      await until(`${grantBarrier}.done`);
      expect(await ended(append)).toBe(0);
      expect(await ended(grant)).toBe(0);
      expect(result(barrier).find((run: { sourcePostId: string }) => run.sourcePostId === source.id)).toMatchObject({ sourcePostId: source.id, status: "posted" });
      expect(loadThread(thread).posts.filter((p) => p.kind === "snapshot" && p.inReplyTo.includes(source.id))).toHaveLength(1);
      if (mode === "disable") setListenerEnabled(thread, true);
      else { edit(record); setListenerEnabled(thread, true); } // editing the record itself is a manual, non-cooperating operation
    }
  }, 30000);

  it("disable or edited re-enable wins while model is outside mutation lock; stale revision refuses", async () => {
    const { root, thread, record } = fixture();
    for (const mode of ["disable", "enable"]) {
      const source = appendPost(thread, { body: `Input ${mode}` }).post;
      const barrier = join(root, `grant-first-${mode}`);
      const append = start("model", thread, barrier, root);
      await until(`${barrier}.model-ready`);
      if (mode === "enable") edit(record);
      const grant = start(mode, thread, `${barrier}-grant`, root);
      await until(`${barrier}-grant.done`);
      expect(await ended(grant)).toBe(0);
      writeFileSync(`${barrier}.model-release`, "go");
      await until(`${barrier}.done`);
      expect(await ended(append)).toBe(0);
      expect(result(barrier).find((run: { sourcePostId: string }) => run.sourcePostId === source.id)).toMatchObject({ sourcePostId: source.id, status: "failed" });
      expect(loadThread(thread).posts.filter((p) => p.kind === "snapshot" && p.inReplyTo.includes(source.id))).toHaveLength(0);
      if (mode === "disable") setListenerEnabled(thread, true);
    }
  }, 30000);

  it("killed lock holder is not stolen; manual stale-lock removal and interrupted run inspection", async () => {
    const { root, thread } = fixture();
    const source = appendPost(thread, { body: "Crash input" }).post;
    const barrier = join(root, "killed");
    const append = start("append", thread, barrier, root);
    await until(`${barrier}.verified`);
    append.kill("SIGKILL");
    expect(await ended(append)).not.toBe(0);
    const grant = start("disable", thread, `${barrier}-grant`, root);
    await until(`${barrier}-grant.error`);
    expect(await ended(grant)).toBe(1);
    expect(readFileSync(`${barrier}-grant.error`, "utf8")).toMatch(/Stale listener mutation lock.*inspect Thread and ledger/);
    expect(loadThread(thread).posts.filter((p) => p.kind === "snapshot" && p.inReplyTo.includes(source.id))).toHaveLength(0);
    const lock = join(root, ".ideaspaces", "listeners", readdirSync(join(root, ".ideaspaces", "listeners"))[0], "mutation.lock");
    expect(readFileSync(lock, "utf8")).toContain(String(append.pid));
    // Operator has inspected the source/absence and writing ledger; only then explicitly clears the stale lock.
    unlinkSync(lock);
    const recovery = start("disable", thread, `${barrier}-recovered`, root);
    await until(`${barrier}-recovered.done`);
    expect(await ended(recovery)).toBe(0);
    const ledger = join(root, ".ideaspaces", "listeners", readdirSync(join(root, ".ideaspaces", "listeners"))[0], "ledger.json");
    expect(JSON.parse(readFileSync(ledger, "utf8"))[0].status).toBe("writing");
    const scan = start("scan", thread, `${barrier}-scan`, root);
    await until(`${barrier}-scan.done`);
    expect(await ended(scan)).toBe(0);
    expect(result(`${barrier}-scan`)[0]).toMatchObject({ sourcePostId: source.id, status: "uncertain" });
    expect(loadThread(thread).posts.filter((p) => p.kind === "snapshot" && p.inReplyTo.includes(source.id))).toHaveLength(0); // no blind retry
  }, 30000);
});
