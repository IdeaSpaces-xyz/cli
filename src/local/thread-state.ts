/**
 * Where each local post is: only on this disk, committed here, or pushed.
 *
 * "Posted" is not "delivered". A local post is a file; it is on one machine until it is committed
 * and on others only once it is pushed. The Thread tools used to say posted either way, and an
 * agent that was told "posted" could not know the post would be lost with the disk. This reads
 * Git, never the network: pushed means the post is the same in the branch's upstream as of the
 * last fetch, which is the most a local read can honestly say.
 *
 * Six Git calls cover a whole Thread however long, at most: where the folder sits in the repository,
 * `status` for what is not committed, whether HEAD exists and what it holds, the upstream's name, and
 * `diff` against it for what is committed but not pushed. A call that fails for any reason but "this
 * is not a repository" or "there is no commit yet" leaves the state unknown and says why; it never
 * refuses the read and never reads as local or pushed.
 */
import { spawnSync } from "node:child_process";
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
  /** Post files in a merge conflict. They count as local: a conflicted file is not safe anywhere. */
  unmerged: Set<string>;
  counts: Record<PostState, number>;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string; status: number | null } {
  // Reading must not write: without this, `git status` refreshes the index and can take index.lock under a concurrent commit.
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }), maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  return { ok: !result.error && result.status === 0, status: result.error ? null : result.status, out: result.stdout ?? "", err: (result.stderr ?? "").trim() || result.error?.message || "" };
}

const unchecked = (note: string): ThreadShare => ({ checked: false, note, upstream: null, states: new Map(), modified: new Set(), unmerged: new Set(), counts: { local: 0, committed: 0, pushed: 0 } });

/** The state of every post file in a Thread folder. `files` are the post file names the Thread reader found. */
export function readThreadShare(threadDir: string, files: readonly string[]): ThreadShare {
  const where = git(threadDir, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  if (!where.ok) {
    // Only Git's own "not a repository" means every post is just a file here; a missing binary or a timeout is unknown.
    if (where.status === 128 && /not a git repository/i.test(where.err)) {
      const states = new Map(files.map((file) => [file, "local" as PostState]));
      return { checked: true, note: "this folder is not in a Git repository, so no post is committed or pushed", upstream: null, states, modified: new Set(), unmerged: new Set(), counts: { local: files.length, committed: 0, pushed: 0 } };
    }
    return unchecked(`Git could not be asked${where.err ? `: ${where.err.split("\n").pop()}` : ""}`);
  }
  const [inside, prefix = ""] = where.out.split("\n").map((line) => line.trim());
  if (inside !== "true") return unchecked("this folder is not inside a Git working tree, so its posts' state is unknown");
  // `status` names paths from the repository root; keep only this folder's direct files (not `_agent/` or a child folder).
  const direct = (path: string): string | undefined => {
    const rest = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    return rest.includes("/") ? undefined : rest;
  };
  const status = git(threadDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (!status.ok) return unchecked(`Git could not report this Thread's status${status.err ? `: ${status.err.split("\n").pop()}` : ""}`);
  const local = new Set<string>();
  const modified = new Set<string>();
  const unmerged = new Set<string>();
  const entries = status.out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const code = entry.slice(0, 2), name = direct(entry.slice(3));
    // A rename or copy names its source in the next entry; the new name is the post's file now.
    if (code[0] === "R" || code[0] === "C") i++;
    if (name === undefined) continue;
    // A file in a merge conflict (UU, AA, DD, AU, UA, DU, UD) is in no settled state: never safe, never pushed.
    if (code[0] === "U" || code[1] === "U" || code === "AA" || code === "DD") { unmerged.add(name); local.add(name); continue; }
    if (code === "??" || code[0] === "A") local.add(name);
    else if (code.includes("M") || code.includes("T") || code[0] === "R") modified.add(name);
    // A deleted file has no post to give a state; `threads check` reports deletions.
  }

  // What HEAD holds, directly in this folder. A file it lacks is only a file here, however Git's status came to hide it:
  // a path in .gitignore never appears in status, and a staged rename's new name is not committed yet. A repository with no
  // commit yet has no HEAD, and then every post is local, which is true. Any other failure to read HEAD is unknown, never local.
  const haveHead = git(threadDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  let inHead = new Set<string>();
  if (haveHead.ok) {
    const tree = git(threadDir, ["ls-tree", "-z", "--name-only", "HEAD", "--", "."]);
    if (!tree.ok) return unchecked(`Git could not list what is committed${tree.err ? `: ${tree.err.split("\n").pop()}` : ""}`);
    inHead = new Set(tree.out.split("\0").filter((path) => path && !path.includes("/")));
  } else if (!(haveHead.status === 1 && !haveHead.err)) {
    return unchecked(`Git could not read HEAD${haveHead.err ? `: ${haveHead.err.split("\n").pop()}` : ""}`);
  }

  const upstreamRef = git(threadDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = upstreamRef.ok ? upstreamRef.out.trim() : null;
  const unpushed = new Set<string>();
  let note: string | undefined;
  let compared = false;
  if (upstream) {
    // Two-dot: it also lists a file only the upstream changed, which is harmless here, because only this checkout's posts are looked up.
    const diff = git(threadDir, ["diff", "--name-only", "-z", "--no-renames", "--relative", upstream, "HEAD", "--", "."]);
    compared = diff.ok;
    if (diff.ok) {
      for (const path of diff.out.split("\0").filter(Boolean)) if (!path.includes("/")) unpushed.add(path);
    } else note = `Git could not compare this Thread with ${upstream}${diff.err ? `: ${diff.err.split("\n").pop()}` : ""}; committed posts are not checked for a push`;
  } else {
    note = "this branch has no upstream, so a committed post may not be pushed; Git was not asked about a remote";
  }

  const states = new Map<string, PostState>();
  const counts: Record<PostState, number> = { local: 0, committed: 0, pushed: 0 };
  for (const file of files) {
    const state: PostState = local.has(file) || !inHead.has(file) ? "local" : !compared || unpushed.has(file) ? "committed" : "pushed";
    states.set(file, state);
    counts[state]++;
  }
  return { checked: true, ...(note ? { note } : {}), upstream, states, modified, unmerged, counts };
}

/** The words for a state in text a person or an agent reads. */
export const STATE_WORDS: Record<PostState, string> = { local: "local only", committed: "committed", pushed: "pushed" };

/** One line for the Thread: what is not safe elsewhere yet. */
export function shareLine(share: ThreadShare): string | undefined {
  if (!share.checked) return `Post state unknown: ${share.note}.`;
  const { local, committed, pushed } = share.counts;
  const parts = [local ? `${local} local only (on this disk, not committed)` : "", committed ? `${committed} committed${share.upstream ? ` (not pushed to ${share.upstream})` : ""}` : "", pushed ? `${pushed} pushed` : ""].filter(Boolean);
  const where = share.upstream ? ` Pushed is as of the last fetch of ${share.upstream}.` : "";
  const modified = share.modified.size ? ` ${share.modified.size} post file${share.modified.size === 1 ? " was" : "s were"} changed after commit: ${[...share.modified].slice(0, 3).join(", ")}${share.modified.size > 3 ? ", …" : ""}; posts are immutable, run threads check.` : "";
  const conflicted = share.unmerged.size ? ` ${share.unmerged.size} post file${share.unmerged.size === 1 ? " is" : "s are"} in a merge conflict and counted as local only: ${[...share.unmerged].slice(0, 3).join(", ")}${share.unmerged.size > 3 ? ", …" : ""}.` : "";
  return `Posts: ${parts.join(", ") || "none"}.${where}${share.note ? ` Note: ${share.note}.` : ""}${conflicted}${modified}`;
}
