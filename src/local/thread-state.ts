/**
 * Where each local post is: only on this disk, committed here, or pushed.
 *
 * "Posted" is not "delivered". A local post is a file; it is on one machine until it is committed
 * and on others only once it is pushed. The Thread tools used to say posted either way, and an
 * agent that was told "posted" could not know the post would be lost with the disk. This reads
 * Git, never the network: pushed means the post is the same in the branch's upstream as of the
 * last fetch, which is the most a local read can honestly say.
 *
 * Two Git calls cover a whole Thread however long: `status` for what is not committed, and `diff`
 * against the upstream for what is committed but not pushed. A failure to ask Git leaves the state
 * unknown and says why; it never refuses the read.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";

/** `local` is only a file here (untracked or staged), `committed` is in this checkout's history, `pushed` is also in the upstream. */
export type PostState = "local" | "committed" | "pushed";

export interface ThreadShare {
  /** False when Git could not be asked; then no post has a state. */
  checked: boolean;
  /** Why it could not be asked, or a note the reader needs (no upstream). */
  note?: string;
  /** The branch's upstream, or null: without one a committed post's "pushed" cannot be known. */
  upstream: string | null;
  /** Keyed by post file name. */
  states: Map<string, PostState>;
  /** Post files whose content changed since they were committed. A post is immutable; this is a flag, not a state. */
  modified: Set<string>;
  counts: Record<PostState, number>;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment(), maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  return { ok: !result.error && result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() || result.error?.message || "" };
}

const unchecked = (note: string): ThreadShare => ({ checked: false, note, upstream: null, states: new Map(), modified: new Set(), counts: { local: 0, committed: 0, pushed: 0 } });

/** The state of every post file in a Thread folder. `files` are the post file names the Thread reader found. */
export function readThreadShare(threadDir: string, files: readonly string[]): ThreadShare {
  const inside = git(threadDir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") {
    // Not a repository: every post is only a file here, and that is the state to report.
    const states = new Map(files.map((file) => [file, "local" as PostState]));
    return { checked: true, note: "this folder is not in a Git repository, so no post is committed or pushed", upstream: null, states, modified: new Set(), counts: { local: files.length, committed: 0, pushed: 0 } };
  }
  const status = git(threadDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (!status.ok) return unchecked(`Git could not report this Thread's status${status.err ? `: ${status.err.split("\n").pop()}` : ""}`);
  const local = new Set<string>();
  const modified = new Set<string>();
  const entries = status.out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const code = entry.slice(0, 2), name = basename(entry.slice(3));
    // A rename or copy names its source in the next entry.
    if (code[0] === "R" || code[0] === "C") i++;
    if (code === "??" || code[0] === "A") local.add(name);
    else if (code.includes("M") || code.includes("T") || code[0] === "R") modified.add(name);
  }

  const upstreamRef = git(threadDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = upstreamRef.ok ? upstreamRef.out.trim() : null;
  const unpushed = new Set<string>();
  let note: string | undefined;
  let compared = false;
  if (upstream) {
    const diff = git(threadDir, ["diff", "--name-only", "-z", "--no-renames", upstream, "HEAD", "--", "."]);
    compared = diff.ok;
    if (diff.ok) for (const path of diff.out.split("\0").filter(Boolean)) unpushed.add(basename(path));
    else note = `Git could not compare this Thread with ${upstream}${diff.err ? `: ${diff.err.split("\n").pop()}` : ""}; committed posts are not checked for a push`;
  } else {
    note = "this branch has no upstream, so a committed post may not be pushed; Git was not asked about a remote";
  }

  const states = new Map<string, PostState>();
  const counts: Record<PostState, number> = { local: 0, committed: 0, pushed: 0 };
  for (const file of files) {
    const state: PostState = local.has(file) ? "local" : !compared || unpushed.has(file) ? "committed" : "pushed";
    states.set(file, state);
    counts[state]++;
  }
  return { checked: true, ...(note ? { note } : {}), upstream, states, modified, counts };
}

/** The words for a state in text a person or an agent reads. */
export const STATE_WORDS: Record<PostState, string> = { local: "local only", committed: "committed", pushed: "pushed" };

/** One line for the Thread: what is not safe elsewhere yet. */
export function shareLine(share: ThreadShare): string | undefined {
  if (!share.checked) return `Post state unknown: ${share.note}.`;
  const { local, committed, pushed } = share.counts;
  const parts = [local ? `${local} local only (on this disk, not committed)` : "", committed ? `${committed} committed (not pushed${share.upstream ? ` to ${share.upstream}` : ""})` : "", pushed ? `${pushed} pushed` : ""].filter(Boolean);
  const where = share.upstream ? ` Pushed is as of the last fetch of ${share.upstream}.` : "";
  const modified = share.modified.size ? ` ${share.modified.size} post file${share.modified.size === 1 ? " was" : "s were"} changed after commit: ${[...share.modified].slice(0, 3).join(", ")}${share.modified.size > 3 ? ", …" : ""}; posts are immutable, run threads check.` : "";
  return `Posts: ${parts.join(", ") || "none"}.${where}${share.note ? ` Note: ${share.note}.` : ""}${modified}`;
}
