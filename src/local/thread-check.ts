/**
 * Which post files changed after they were written.
 *
 * A Thread post is immutable: the protocol says so and every reader relies on it, but on a local
 * disk nothing enforces it. Explorer measured 41 modified posts in one Space's history on
 * 2026-11-05, most of them author corrections, and nothing reported them. This reads Git and says
 * which post files were edited or deleted after they were first committed, and which have an
 * uncommitted edit now. It repairs nothing and ignores READMEs and `_agent/`, which are curated on
 * purpose. One `git log` and one `git status` cover a whole Space.
 */
import { spawnSync } from "node:child_process";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";

export interface PostChange {
  kind: "edited" | "deleted" | "uncommitted-edit" | "uncommitted-delete";
  commit?: string;
  author?: string;
  date?: string;
  subject?: string;
}
export interface ModifiedPost { thread: string; file: string; changes: PostChange[] }
export interface ThreadCheck {
  /** False when Git could not be asked; `note` says why and nothing is claimed clean. */
  checked: boolean;
  note?: string;
  modified: ModifiedPost[];
}

// Reading must not write: `git status` otherwise refreshes the index and can take index.lock under a concurrent commit.
function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }), maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
  return { ok: !result.error && result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() || result.error?.message || "" };
}

/** `<slug>/<post>.md` relative to `_threads/`: a direct post file, never a README or something under `_agent/`. */
function postPath(path: string): { thread: string; file: string } | undefined {
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[1].endsWith(".md") || parts[1] === "README.md" || parts[0].startsWith(".")) return undefined;
  return { thread: parts[0], file: parts[1] };
}

/**
 * Edited or deleted post files under a `_threads/` folder, optionally one Thread, newest change first.
 * `threadsDir` is the `_threads/` folder itself.
 */
export function checkThreads(threadsDir: string, only?: string): ThreadCheck {
  const inside = git(threadsDir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") {
    return { checked: false, note: "this Space is not in a Git repository, so there is no history to check; posts here cannot be shown to be unchanged", modified: [] };
  }
  // A literal pathspec: a slug with glob characters must match only itself.
  const scope = only ? [`:(literal)${only}`] : ["."];
  const found = new Map<string, ModifiedPost>();
  const add = (path: string, change: PostChange) => {
    const post = postPath(path);
    if (!post || (only && post.thread !== only)) return;
    const key = `${post.thread}/${post.file}`;
    const entry = found.get(key) ?? { ...post, changes: [] };
    entry.changes.push(change);
    found.set(key, entry);
  };

  // `status` names paths from the repository root; `log --relative` names them from here.
  const prefix = git(threadsDir, ["rev-parse", "--show-prefix"]).out.trim();
  const fromHere = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);
  const status = git(threadsDir, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--", ...scope]);
  if (!status.ok) return { checked: false, note: `Git could not report the working tree${status.err ? `: ${status.err.split("\n").pop()}` : ""}`, modified: [] };
  const entries = status.out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2), path = fromHere(entries[i].slice(3));
    // A rename or copy names its source in the next entry. The source is gone from this name; the new name is the post's file now.
    if (code[0] === "R" || code[0] === "C") {
      const origin = fromHere(entries[++i] ?? "");
      if (code[0] === "R" && origin) add(origin, { kind: "uncommitted-delete" });
      add(path, { kind: "uncommitted-edit" });
      continue;
    }
    // Staged as new (`A`, `AM`, `AD`) means it was never committed: an addition, not a change after commit.
    if (code[0] === "A" || code[0] === "?") continue;
    if (code.includes("D")) add(path, { kind: "uncommitted-delete" });
    else if (code.includes("M") || code.includes("T")) add(path, { kind: "uncommitted-edit" });
  }

  // A shallow clone's history stops at the fetch depth, so an edit before it is invisible: that is not "clean".
  const shallow = git(threadsDir, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.ok && shallow.out.trim() === "true") {
    return { checked: false, note: "this clone is shallow (its history stops at the fetch depth), so an edit made before that cannot be seen; fetch the full history (git fetch --unshallow) to check", modified: [...found.values()] };
  }

  const log = git(threadsDir, ["-c", "core.quotePath=false", "log", "--no-renames", "--diff-filter=MDT", "--name-status", "--relative", "--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s", "--", ...scope]);
  if (!log.ok) {
    // An empty repository has no history; that is clean, not a failure.
    if (/does not have any commits yet/.test(log.err)) return { checked: true, modified: [...found.values()] };
    return { checked: false, note: `Git could not read the history${log.err ? `: ${log.err.split("\n").pop()}` : ""}`, modified: [...found.values()] };
  }
  for (const block of log.out.split("\x1e").filter(Boolean)) {
    const [header, ...lines] = block.split("\n");
    const [commit, author, date, subject] = header.split("\x1f");
    for (const line of lines) {
      const [code, path] = line.split("\t");
      if (!path) continue;
      add(path, { kind: code === "D" ? "deleted" : "edited", commit, author, date, subject });
    }
  }
  return { checked: true, modified: [...found.values()].sort((a, b) => `${a.thread}/${a.file}`.localeCompare(`${b.thread}/${b.file}`)) };
}

const CHANGE_WORDS: Record<PostChange["kind"], string> = {
  edited: "edited in", deleted: "deleted in", "uncommitted-edit": "edited, not committed", "uncommitted-delete": "deleted, not committed",
};

/** The report a person or an agent reads. */
export function checkText(result: ThreadCheck, scope: string): string {
  if (!result.checked) return `Not checked: ${result.note}.${result.modified.length ? `\nFound before it stopped:\n${listModified(result.modified)}` : ""}`;
  if (!result.modified.length) return `${scope}: no post file was changed after it was first committed.`;
  const noun = result.modified.length === 1 ? "post file was" : "post files were";
  return `${scope}: ${result.modified.length} ${noun} changed after it was first committed. Posts are immutable; a correction is a new post.\n${listModified(result.modified)}`;
}

function listModified(modified: readonly ModifiedPost[]): string {
  return modified.map((post) => `- ${post.thread}/${post.file}\n${post.changes.map((change) => `    ${CHANGE_WORDS[change.kind]}${change.commit ? ` ${change.commit.slice(0, 9)} (${change.date?.slice(0, 10) ?? "undated"}, ${change.author ?? "unknown"}): ${(change.subject ?? "").slice(0, 120)}` : ""}`).join("\n")}`).join("\n");
}
