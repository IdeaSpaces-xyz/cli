import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter, parseThreadAttachment, parseThreadPost, type ThreadKind } from "@ideaspaces/protocol";
import { loadLocalThreadMap, selectPinnedThreadMember } from "../local/thread-map-member.js";
import { selectLocalThreadTarget } from "../local/cross-thread-target.js";
import { apiErrorDetail, fetchExchange, fetchInbox, fetchSpaceThreads, UnauthorizedError, type ThreadGrade } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef } from "../types.js";
import { exchangeText, hostedThreadsCommand, threadBadges } from "./inbox.js";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import {
  acknowledge, appendPost, createThread, initWorktree, listLocal, loadThread,
  pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread, threadBase, NoAgreementError,
  resolveThreadParent, findChildThreads, findNewestSnapshot, computeBranches, latestLocalActivity,
  type LocalThread, type BranchInfo, type ChildThreadInfo, type ThreadParentInfo,
} from "../local/threads.js";
import { HOSTED_THREAD_ID as HOSTED, threadFlagError, type Flags } from "./thread-flags.js";

export { threadFlagError } from "./thread-flags.js";

const SURFACE_BODY_BYTES = 800;
const KNOWN_POST_KINDS = new Set(["post", "snapshot", "reframe", "correction", "closure", "mark"]);
function str(flags: Flags, key: string): string | undefined {
  return typeof flags[key] === "string" ? flags[key] : undefined;
}
function yes(flags: Flags, key: string): boolean {
  if (flags[key] === undefined) return false;
  if (flags[key] === true || flags[key] === "true") return true;
  throw new Error(`--${key} does not take a value.`);
}
function selectionFlags(flags: Flags): void {
  if (flags.map === undefined && (flags.member !== undefined || flags.checkout !== undefined)) throw new Error("--member and --checkout require --map.");
  if (flags.checkout === true) throw new Error("--checkout requires an absolute Space root path.");
}
type ThreadDepth = "name" | "summary" | "children" | "surface" | "full";
function depth(flags: Flags, fallback: string): ThreadDepth {
  const value = flags.depth ?? fallback;
  if (value === "name" || value === "summary" || value === "children" || value === "surface" || value === "full") return value;
  throw new Error("--depth must be name, summary, children, surface or full.");
}
async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}


function localRows(threads: LocalThread[], newOnly: boolean, onError: (message: string) => void) {
  return threads.filter((thread) => {
    if (!newOnly) return true;
    const seen = readCursor(thread);
    return thread.posts.some((post) => !seen.has(post.id));
  }).map((thread) => {
    let parent: ThreadParentInfo | null = null;
    let parent_warning: string | undefined;
    try { parent = resolveThreadParent(thread.path, threads); }
    catch (error) {
      parent_warning = `Thread ${thread.slug} parent cannot be read: ${error instanceof Error ? error.message : String(error)}`;
      onError(parent_warning);
    }
    return { source: "local" as const, id: thread.path, thread_id: thread.thread_id, slug: thread.slug, name: thread.name,
      summary: thread.summary, count: thread.allPosts.length, closed: thread.closed,
      warnings: thread.warnings, unreadable_posts: thread.unreadablePosts,
      latest_activity_at: latestLocalActivity(thread.posts), parent, ...(parent_warning ? { parent_warning } : {}) };
  });
}
function reportThreadWarnings(thread: LocalThread, output: Output): void {
  for (const warning of new Set(thread.warnings)) output.log(`Thread ${thread.slug}: ${warning}`);
}

function clip(text: string, bytes: number, marker = "… [shortened; read the exact file or use --post <id>]"): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  let size = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (size + charBytes > bytes) break;
    result += char;
    size += charBytes;
  }
  return result + marker;
}
function threadSection(markdown: string, heading: string): string | undefined {
  const match = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(markdown);
  return match?.[1]?.trim() || undefined;
}
function threadFrame(thread: LocalThread) {
  // loadThread validates the Agreement, but it can disappear between the two
  // reads. A missing target frame does not erase the curated README frame.
  let agreement = "";
  try {
    agreement = readFileSync(join(thread.path, "_agent", "agreement.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    current_frame: threadSection(thread.readme, "Current frame"),
    goal: threadSection(agreement, "Goal"),
    done_when: threadSection(agreement, "Done when"),
  };
}
function localText(
  thread: LocalThread,
  posts: LocalThread["posts"],
  rung: ThreadDepth,
  options?: {
    frame?: ReturnType<typeof threadFrame>;
    parent?: ThreadParentInfo | null;
    snapshot?: LocalThread["posts"][number] | null;
    branches?: BranchInfo[];
    childThreads?: ChildThreadInfo[];
    branchTotal?: number;
    childThreadTotal?: number;
    childWarnings?: number;
    filtered?: boolean;
  },
): string {
  const header = `${thread.slug}  ${thread.name}`;
  if (rung === "name") {
    const lens = options?.frame ?? threadFrame(thread);
    const parentLine = options?.parent ? options.parent.status === "unknown" ? "Parent: unknown (opening post unreadable)" : `Attached to: ${clip(options.parent.attached_to, 400)}` : undefined;
    return [
      header,
      parentLine,
      lens.current_frame && `Current frame: ${clip(lens.current_frame, 1200, "… [shortened; read this Thread's README.md for the full frame]")}`,
      lens.goal && `Goal: ${clip(lens.goal, 1200, "… [shortened; read this Thread's _agent/agreement.md for the full goal]")}`,
      lens.done_when && `Done when: ${clip(lens.done_when, 1200, "… [shortened; read this Thread's _agent/agreement.md for the full criterion]")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const context = `${rung === "full" ? thread.name : clip(thread.name, 200)} (${thread.path})\n${rung === "full" ? thread.summary : clip(thread.summary, 400)}\n${thread.closed === "unknown" ? "closed: unknown" : thread.closed ? "closed" : "open"} · ${thread.allPosts.length} posts`;

  if (rung === "summary") {
    const parts = [context];
    if (options?.parent) {
      const p = options.parent;
      parts.push(`Parent post: ${p.id ?? p.attached_to}${p.slug ? ` (${p.slug})` : ""}${p.name ? ` · ${clip(p.name, 200)}` : ""}${p.summary ? `\n  ${clip(p.summary, 400)}` : ""}`);
    }
    if (options?.snapshot) {
      const s = options.snapshot;
      parts.push(`Latest snapshot: ${s.id} · ${s.kind} · ${s.date ?? "undated"} · ${clip(s.frontmatter.name ?? s.id, 200)} · ${s.frontmatter.author ?? "unknown author"}\n  ${clip(s.frontmatter.summary ?? "(no summary)", 400)}`);
    }
    if (options?.filtered && posts.length) {
      parts.push(
        posts
          .map(
            (p) =>
              `${p.id} · ${p.kind} · ${p.date ?? "undated"} · ${clip(p.frontmatter.name ?? p.id, 200)} · in_reply_to ${p.inReplyTo.join(", ") || "—"} · ${p.frontmatter.author ?? "unknown author"}${p.marks?.length ? ` · marks: ${p.marks.map((m) => `${m.mark} (${m.author || "anonymous"})`).join(", ")}` : ""}\n  ${clip(p.frontmatter.summary ?? "(no summary)", 400)}`,
          )
          .join("\n\n"),
      );
    }
    return parts.join("\n\n");
  }

  if (rung === "children") {
    const parts = [context];
    if (options?.parent) {
      parts.push(`Parent: ${clip(options.parent.attached_to, 400)}${options.parent.slug ? ` (${options.parent.slug})` : ""}`);
    }
    const branches = options?.branches ?? [];
    if (branches.length) {
      parts.push(`Branches (${branches.length} of ${options?.branchTotal ?? branches.length}):\n${branches.map((b) => `  ${clip(b.root_name, 200)} (${b.root_id}) → ${clip(b.tip_name, 200)} (${b.tip_id}) · ${b.count} posts`).join("\n")}`);
    }
    if (options?.childThreads && options.childThreads.length > 0) {
      const childLines = options.childThreads.map(
        (c) => `  ${c.slug}  ${clip(c.name, 200)}\n    attached to ${c.attached_to_post_id ?? c.attached_to} · ${c.count} posts · ${c.closed === "unknown" ? "closed: unknown" : c.closed ? "closed" : "open"}${c.latest_activity_at ? ` · latest: ${c.latest_activity_at}` : ""}\n    summary: ${clip(c.summary || "(no summary)", 200)}`,
      );
      parts.push(`Child Threads (${options.childThreads.length} of ${options.childThreadTotal ?? options.childThreads.length} known):\n${childLines.join("\n")}`);
    }
    if (options?.childWarnings) parts.push(`Child Thread lookup incomplete: ${options.childWarnings} unreadable sibling(s).`);
    return parts.join("\n\n");
  }

  return [
    context,
    ...posts.map(
      (p) =>
        `\n${p.id} · ${p.frontmatter.author ?? "unknown author"} · ${p.kind}${p.inReplyTo.length ? ` ↳ ${p.inReplyTo.join(", ")}` : ""}${p.frontmatter.tags?.length ? ` · tags: ${p.frontmatter.tags.join(", ")}` : ""}\n${p.frontmatter.name ?? ""}\n${p.body}${p.marks?.length ? `\nMarks: ${p.marks.map((m) => `${m.mark} (${m.author || "anonymous"})`).join(", ")}` : ""}`,
    ),
  ].join("\n");
}
function selectedWriterName(): string {
  const cwd = realpathSync(process.cwd());
  const prefix = spawnSync(gitBinary(), ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8", env: sanitizedGitEnvironment() });
  // Derive the checkout root from native cwd, not Git's differently spelled
  // --show-toplevel (Windows). Never ascend into a parent checkout's Agreement.
  const boundary = prefix.status === 0
    ? prefix.stdout.trim().split("/").filter(Boolean).reduce((at) => dirname(at), cwd)
    : cwd;
  let at = cwd;
  while (true) {
    const pathFromRoot = relative(boundary, at);
    const outsideRoot = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
    if (outsideRoot) break;
    const agentDir = join(at, "_agent");
    const agreement = join(agentDir, "agreement.md");
    if (existsSync(agentDir) || existsSync(agreement)) {
      if (!existsSync(agentDir) || lstatSync(agentDir).isSymbolicLink() || !lstatSync(agentDir).isDirectory() ||
          !existsSync(agreement) || lstatSync(agreement).isSymbolicLink() || !lstatSync(agreement).isFile()) {
        throw new Error("Caller POV needs a regular _agent/agreement.md with a name to author a selected Thread post.");
      }
      const fm = parseFrontmatter(readFileSync(agreement, "utf8"));
      if (typeof fm?.name !== "string" || !fm.name.trim() ||
          (fm.agreement !== undefined && (typeof fm.agreement !== "string" || !fm.agreement.startsWith("agent:repo:")))) {
        throw new Error("Caller POV _agent/agreement.md needs an agent name (and agent:repo: kind if declared) to author a selected Thread post.");
      }
      const name = fm.name.replace(/^Agreement\s*[—-]\s*/, "").trim();
      if (!name || name.length > 900 || /[\r\n]/.test(name)) throw new Error("Caller Agreement name must be a single line of at most 900 characters.");
      return name;
    }
    if (at === boundary) break;
    at = dirname(at);
  }
  throw new Error("Selected Thread posts require the caller's own _agent/agreement.md with a name; no git-author fallback.");
}
function writerName(explicit?: string): string {
  if (explicit) return explicit;
  let at = resolve(process.cwd());
  while (true) {
    const agreement = join(at, "_agent", "agreement.md");
    if (existsSync(agreement)) {
      const fm = parseFrontmatter(readFileSync(agreement, "utf8"));
      if (typeof fm?.agreement === "string" && fm.agreement.startsWith("agent:repo:") && typeof fm.name === "string") {
        return fm.name.replace(/^Agreement\s*[—-]\s*/, "");
      }
    }
    if (dirname(at) === at) break;
    at = dirname(at);
  }
  const result = spawnSync(gitBinary(), ["config", "user.name"], { cwd: process.cwd(), encoding: "utf8", env: sanitizedGitEnvironment() });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  throw new Error("No writer identity. Pass --author <name> (or set git user.name / run from an agent Agreement).");
}

export const threadsCommand: CommandDef = {
  name: "threads",
  description: "List, read and write local or hosted Threads (local posts stay in Git)",
  usage: "ideaspaces threads <list|posts|locate|open|new|post|close|render|init|push|read|send|reply|expand> ... | threads <add|rename> <hosted-x_id> ...",
  examples: [
    "ideaspaces threads list [<dir>] [--new] [--space n_…]",
    "ideaspaces threads posts [--space n_…] [--scope inbox|followed] [--limit 10] [--since <id|pos|date>] [--depth name|summary] [--order newer|older]",
    "ideaspaces threads posts --cursor eyJwIjo2NywibyI6ImRlc2MifQ==",
    "ideaspaces threads locate msg_<opening-post-id> <space-root> [<space-root> ...]  # --json status: found|not_found|ambiguous; all exit 0", 
    "ideaspaces threads open <slug|path|x_id> [--depth name|summary|children|surface|full] [--new] [--limit 10] [--order newer|older]  # local cold default: surface",
    "ideaspaces threads new <slug> --about 'What we are deciding' [--attached-to post:msg_parent]  # optional child edge",
    "ideaspaces threads new <slug> --about 'About this Note' --attached-to note:@home//notes/topic.md  # link, no child edge",
    "ideaspaces threads read <local-slug|path> --json  # alias of open, includes post dates",
    "ideaspaces threads post <slug|path> --message 'Decision' [--reply-to id1,id2|latest] [--tags friction,ux]  # max 20 distinct tags, 200 chars each; no reply-to branches from opening",
    "ideaspaces threads post <slug> --kind mark --mark claimed --reply-to msg_target --message 'Claimed'  # folded onto target, off timeline",
    "ideaspaces threads post <slug> --kind snapshot --message 'State'  # known: post, snapshot, reframe, correction, closure, mark; custom kinds warn but remain valid",
    "ideaspaces threads post <slug> --message 'Decision' --map home.map.md --member 0 --reply-to msg_id [--checkout /absolute/space/root]",
    "ideaspaces threads open <slug|path> --map home.map.md --member 0  # same-Space authored pin",
    "ideaspaces threads open <slug> --map home.map.md --member 0 [--checkout /absolute/space/root]  # selected pin only",
    "ideaspaces threads open <slug|path> --pin <40-hex-sha> --position _threads/<slug>/<post>.md",
    "ideaspaces threads close <slug|path> --message 'Closing rationale'  # local",
    "ideaspaces threads close x_<id>  # preview; add --yes to close as owner",
    "ideaspaces threads add x_<id> @handle --grade view  # preview; add --yes to grant as hosted owner",
    "ideaspaces threads rename x_<id> --name 'New title'  # applies immediately; hosted owner only",
    "ideaspaces threads send @handle --grade view --name 'Question' --summary 'One decision' --message '…'",
    "ideaspaces threads reply x_<id> --name 'Answer' --summary 'Summary' --message '…' [--reply-to n_…]",
    "ideaspaces threads list --kind message --json  # hosted rows include your_grade and closed",
    "ideaspaces threads render <slug|path>  # derived timeline; README stays curated",
    "ideaspaces threads init  # isolated orphan threads worktree at _threads/",
    "ideaspaces threads push --remote <team-remote>  # never origin/GitHub",
    "ideaspaces threads read x_<id> --new --ack  # hosted",
    "ideaspaces threads open <slug> --depth children  # branches/children default newer; post ranges default older",
    "ideaspaces threads open <slug> --depth surface --limit 5  # head counts toward the limit; --order newer reverses the selected page",
    "ideaspaces threads open <slug> --depth full --limit 10 --order older  # page history; --since <post-id> continues (older order only)",
    "ideaspaces threads open <slug> --post msg_<id>  # one exact post plus child Threads attached to it",
    "ideaspaces threads open <slug|x_id> --post <id>  # one post in full, regardless of --depth",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    try {
      const flagError = threadFlagError(sub ?? "", flags);
      if (flagError) throw new Error(flagError);
      if ((sub === "open" || sub === "read") && HOSTED.test(rest[0] ?? "") && (flags.limit !== undefined || flags.order !== undefined)) {
        throw new Error("Local open only: --limit and --order are not supported for hosted Threads.");
      }
      if (sub === "read" || sub === "send" || sub === "reply" || sub === "expand" || sub === "add" || sub === "rename" || sub === "posts" || (sub === "close" && HOSTED.test(rest[0] ?? ""))) {
        if (sub === "read" && rest.length === 1 && !HOSTED.test(rest[0])) {
          return threadsCommand.run(["open", rest[0]], flags, global);
        }
        return hostedThreadsCommand.run(args, flags, global);
      }
      if (sub === "locate") {
        if (rest.length < 2 || !/^msg_[0-9a-f-]+$/.test(rest[0])) throw new Error("Usage: threads locate <opening-post-id> <space-root> [<space-root> ...]");
        const matches = [...new Map(rest.slice(1).flatMap((root) => {
          if (!existsSync(resolve(root))) throw new Error(`Space root not found: ${root}. Supply an existing folder with _agent/agreement.md.`);
          if (lstatSync(resolve(root)).isSymbolicLink()) throw new Error(`Refusing symlink Space root: ${root}`);
          const requested = realpathSync(resolve(root));
          if (threadBase(requested) !== requested) throw new Error(`Not a Space root: ${root}. Supply the folder with _agent/agreement.md.`);
          return listLocal(requested);
        })
          .filter((thread) => thread.thread_id === rest[0]).map((thread) => [thread.path, thread])).values()];
        const status = matches.length === 1 ? "found" : matches.length ? "ambiguous" : "not_found";
        output.result({ status, thread_id: rest[0], matches: matches.map(({ path, slug, name }) => ({ path, slug, name })) },
          status === "found" ? matches[0].path : status === "ambiguous" ? `Ambiguous Thread id: ${matches.length} locations. Select a Space explicitly:\n${matches.map((t) => `- ${t.path}`).join("\n")}` : "Thread not found in the supplied Space roots.");
        return 0;
      }
      if (sub === "list") {
        if (flags.depth === "children" || flags.depth === "surface") throw new Error("threads list supports name, summary or full; use threads open for a Thread rung.");
        if (rest.length > 1 || (rest.length && str(flags, "space"))) throw new Error("Usage: threads list [<dir>] [--space n_…] [--new]");
        const newOnly = yes(flags, "new");
        const rung = depth(flags, "summary");
        const space = str(flags, "space");
        if (space && newOnly) throw new Error("--space and --new cannot be combined (hosted Space listing has no per-reader cursor).");
        if (flags.kind === "request") throw new Error("Access requests are notifications, not Threads; use the legacy `ideaspaces inbox list --kind request` for this release.");
        if (flags.kind !== undefined || flags.since !== undefined || rung === "full" && space) {
          if (rest.length) throw new Error("Hosted filters cannot be combined with a local directory.");
          return hostedThreadsCommand.run(args, flags, global);
        }
        const cwd = rest[0] ? resolve(rest[0]) : process.cwd();
        let local: ReturnType<typeof localRows> = [];
        let localThreads: LocalThread[] = [];
        let localWarnings = 0;
        const warn = (message: string) => { output.log(message); localWarnings++; };
        if (!space) {
          try {
            localThreads = listLocal(cwd, warn);
            for (const thread of localThreads) {
              reportThreadWarnings(thread, output);
              localWarnings += thread.unreadablePosts.length;
            }
            local = localRows(localThreads, newOnly, warn);
          } catch (error) {
            // Outside a Space, hosted listing still works. A malformed Thread or
            // cursor inside a Space is not an empty list — fail visibly.
            if (rest.length || !(error instanceof NoAgreementError)) throw error;
          }
        }
        const config = loadConfig();
        if (space && !config) throw new Error("Not logged in. Run `ideaspaces login` to list hosted Space Threads.");
        let hosted: Array<{ source: "hosted"; id: string; name: string; summary: string; your_grade?: ThreadGrade; closed?: boolean; count?: number; messages?: unknown[]; text?: string }> = [];
        if (config) {
          try {
            if (space) {
              const result = await fetchSpaceThreads(config, space);
              hosted = result.threads.map((t) => ({ source: "hosted", id: t.exchange_id, name: t.name, summary: t.summary }));
            } else if (!rest.length) {
              const result = await fetchInbox(config);
              hosted = result.items.filter((t) => t.kind === "inquiry")
                .filter((t) => !newOnly || t.cursor !== null && t.latest_position > t.cursor)
                .map((t) => ({ source: "hosted", id: t.exchange_id, name: t.name ?? t.latest_message.name, summary: t.latest_message.summary, your_grade: t.your_grade, closed: t.closed, count: t.message_count }));
            }
          } catch (error) {
            if (!local.length) throw error;
            output.log(`Hosted Threads unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (rung === "full" && config) {
          hosted = await Promise.all(hosted.map(async (row) => {
            try {
              const exchange = await fetchExchange(config, row.id);
              return { ...row, messages: exchange.messages, text: exchangeText(exchange, exchange.messages, "full") };
            } catch (error) {
              if (error instanceof UnauthorizedError) throw error;
              return { ...row, text: `${row.id}  ${row.name}\n  ${apiErrorDetail(error)}` };
            }
          }));
        }
        const rows = [...local, ...hosted].map((row) => {
          if (rung === "name") return { source: row.source, id: row.id, name: row.name,
            ...(row.source === "local" ? { slug: row.slug, thread_id: row.thread_id, latest_activity_at: row.latest_activity_at, parent: row.parent } : { ...(row.your_grade ? { your_grade: row.your_grade } : {}), ...(row.closed !== undefined ? { closed: row.closed } : {}) }) };
          if (rung === "full" && row.source === "local") {
            return { ...row, posts: localThreads.find((thread) => thread.path === row.id)?.posts ?? [] };
          }
          return row;
        });
        const text = rows.map((row) => {
          if (rung === "name") return `${row.id}  ${row.name}${threadBadges("your_grade" in row ? row.your_grade : undefined, "closed" in row && typeof row.closed === "boolean" ? row.closed : undefined)}${"closed" in row && row.closed === "unknown" ? " · closed: unknown" : ""}`;
          if (rung === "full" && "posts" in row && Array.isArray(row.posts)) {
            const thread = localThreads.find((candidate) => candidate.path === row.id)!;
            return localText(thread, row.posts, "full");
          }
          if (rung === "full" && "text" in row && typeof row.text === "string") return row.text;
          return `${row.id}  ${row.name}${threadBadges("your_grade" in row ? row.your_grade : undefined, "closed" in row && typeof row.closed === "boolean" ? row.closed : undefined)}${"closed" in row && row.closed === "unknown" ? " · closed: unknown" : ""}\n  ${"summary" in row ? row.summary : ""} · ${row.source}`;
        }).join("\n\n");
        const hint = !config && !rest.length ? "\nHosted Threads not checked (not logged in; run `ideaspaces login`)." : "";
        output.result({ schema: "ideaspaces.threads.list.v2", threads: rows, hosted_checked: Boolean(config), local_complete: localWarnings === 0 }, (text || "No local Threads here.") + (localWarnings ? `\nLocal Thread listing incomplete: ${localWarnings} unreadable item(s).` : "") + hint);
        return 0;
      }
      if (sub === "new") {
        if (rest.length !== 1 || !str(flags, "about")) throw new Error("Usage: threads new <slug> --about <title> [--attached-to <type>:<id>]");
        const attachedTo = str(flags, "attached-to");
        if (flags["attached-to"] !== undefined && (!attachedTo?.includes(":") || !parseThreadAttachment(attachedTo))) {
          throw new Error("--attached-to requires a valid <type>:<id> value; invalid attached_to field. No Thread created.");
        }
        const thread = createThread(rest[0], str(flags, "about")!);
        let opening: ReturnType<typeof appendPost>;
        try {
          opening = appendPost(thread.path, { body: str(flags, "about")!, name: thread.name, summary: thread.summary, attachedTo });
        } catch (err) {
          throw new Error(`Thread created at ${thread.path}, but opening post was not written: ${err instanceof Error ? err.message : String(err)}. Use threads post ${thread.slug} --message <opening-text> to complete it; do not rerun threads new.`);
        }
        output.result({ path: thread.path, slug: thread.slug, thread_id: opening.post.id, opening_post_id: opening.post.id, date: opening.post.date,
          ...(attachedTo ? { attached_to: attachedTo } : {}) },
          `Created local Thread: ${thread.path}`); return 0;
      }
      if (sub === "open") {
        if (rest.length !== 1) throw new Error("Usage: threads open <path|x_id> [--depth name|summary|children|surface|full] [--post <id>] [--since <date|id>] [--limit <n>] [--order newer|older] [--new] [--ack]");
        if (HOSTED.test(rest[0])) return hostedThreadsCommand.run(["read", rest[0]], flags, global);
        selectionFlags(flags);
        if (flags.map !== undefined && flags.member === undefined) throw new Error("Pinned open with --map requires --member <zero-based ordinal>; no live HEAD fallback.");
        if (flags.map !== undefined && flags.member !== undefined) {
          if (flags.limit !== undefined || flags.order !== undefined) throw new Error("Pinned selection opens one authored post; omit --limit and --order.");
          if (flags.since !== undefined || flags.post !== undefined) throw new Error("Selected pinned open cannot use --since or --post; select one authored post with --member.");
          if (flags.pin !== undefined || flags.position !== undefined) throw new Error("Use either --map with --member or --pin with --position, not both.");
          if (flags.new !== undefined || flags.ack !== undefined) throw new Error("Selected pinned reads cannot use live --new or --ack.");
          const { root, member } = selectPinnedThreadMember(loadLocalThreadMap(str(flags, "map") ?? ""), str(flags, "member") ?? "");
          const target = selectLocalThreadTarget(rest[0], root, member, str(flags, "checkout"));
          const rung = depth(flags, "summary");
          const post = target.post;
          const postName = post.frontmatter.name ?? post.id;
          const postSummary = post.frontmatter.summary ?? "";
          const posts = rung === "name" ? [] : rung === "summary" || rung === "children" ? [{ id: post.id, path: post.path, kind: post.kind,
            date: post.date ?? null, name: postName, ...(rung === "summary" ? { summary: post.frontmatter.summary ?? null } : {}), in_reply_to: post.inReplyTo }] : [post];
          if (post.warnings?.length) for (const warning of post.warnings) output.log(`Post ${target.position}: ${warning.field}: ${warning.warning}`);
          output.result({ thread: { path: target.thread.path, name: target.name, summary: rung === "name" ? undefined : target.summary },
            posts, ...(post.warnings?.length ? { warnings: post.warnings.map((warning) => ({ post: target.position, ...warning })) } : {}),
            ...(rung === "full" ? { pinned: target.pinned } : {}), pin: target.pin, position: target.position, acknowledged: false },
            rung === "full" || rung === "surface" ? target.pinned : rung === "name" ? target.name : rung === "children" ? `${post.id} · ${post.kind} · ${post.date ?? "undated"} · ${postName} · in_reply_to ${post.inReplyTo.join(", ") || "—"}` : `${target.name}\n${post.id} · ${post.kind} · ${post.date ?? "undated"} · ${postName} · in_reply_to ${post.inReplyTo.join(", ") || "—"} — ${postSummary || "(no summary)"}`);
          return 0;
        }
        if (flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        const thread = loadThread(resolveLocalThread(rest[0]));
        reportThreadWarnings(thread, output);
        const rung = depth(flags, "surface");
        const postId = str(flags, "post");
        if (flags.post !== undefined && !postId) throw new Error("--post requires a post id.");

        const limitStr = str(flags, "limit");
        let limit: number | undefined;
        if (flags.limit !== undefined) {
          if (!limitStr || !/^\d+$/.test(limitStr) || parseInt(limitStr, 10) <= 0) {
            throw new Error("--limit must be a positive integer.");
          }
          limit = parseInt(limitStr, 10);
        }
        const order = str(flags, "order");
        if (flags.order !== undefined && order !== "newer" && order !== "older") throw new Error("--order must be newer or older.");
        if (rung === "name" && (limit !== undefined || order)) throw new Error("Name reads one frame; omit --limit and --order.");

        const since = str(flags, "since");
        if (flags.since !== undefined && !since) throw new Error("--since requires an ISO date or post id.");
        const newOnly = yes(flags, "new");
        if (newOnly && since) throw new Error("Use either --new or --since, not both.");
        if (since && order === "newer") throw new Error("--since advances forward in time; use --order older to continue a page, or omit --since for the newest page.");
        if (postId && (newOnly || since || limit !== undefined || order)) throw new Error("--post selects one immutable post; omit --new, --since, --limit and --order, which select a range.");
        const seen = newOnly ? readCursor(thread) : new Set<string>();
        let posts = thread.posts.filter((p) => !seen.has(p.id));
        if (since) {
          const at = thread.posts.findIndex((p) => p.id === since);
          // --since post-id is exclusive in the Thread's deterministic post order.
          if (at !== -1) posts = thread.posts.slice(at + 1);
          else if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(since) && !Number.isNaN(Date.parse(since))) {
            const undated = posts.filter((p) => !p.date).length;
            if (undated) output.log(`${undated} undated post(s) in Thread ${thread.slug} cannot be compared to --since ${since}; omitted.`);
            posts = posts.filter((p) => p.date && Date.parse(p.date) > Date.parse(since));
          } else throw new Error(`--since needs a post id in this Thread or a valid ISO date: ${since}`);
        }
        // Count the entire selected range before the surface head moves it.
        // Unseen posts before a snapshot must not be silently acknowledged.
        const rangeCount = posts.length;
        if (postId) {
          const exact = thread.allPosts.find((p) => p.id === postId);
          if (!exact) throw new Error(`Post ${postId} is not in Thread ${thread.slug}.`);
          posts = [thread.posts.find((p) => p.id === postId) ?? exact];
        } else if (rung === "surface") {
          const snapshot = findNewestSnapshot(posts);
          if (snapshot) {
            const at = posts.findIndex((p) => p.id === snapshot.id);
            if (at !== -1) posts = posts.slice(at);
          }
        }
        // Cold summary is a coordinate, not the entire timeline. Full is paged;
        // surface keeps the head and a bounded tail, with --post for exact bodies.
        const filtered = Boolean(since || newOnly || limit !== undefined || order);
        const totalMatching = postId ? 1 : rangeCount;
        if (rung === "summary" && !filtered && !postId) posts = [];
        else if (!postId && rung !== "name" && rung !== "children") {
          if (rung === "surface") {
            const head = posts.find((p) => p.kind === "snapshot" || p.kind === "reframe");
            const tailLimit = (limit ?? 5) - (head ? 1 : 0);
            const tail = tailLimit > 0 ? posts.slice(-tailLimit) : [];
            posts = head ? [head, ...tail.filter((p) => p.id !== head.id)] : tail;
            if (order === "newer") posts.reverse();
          } else {
            if (order === "newer") posts = [...posts].reverse();
            posts = posts.slice(0, limit ?? 10);
          }
        }

        const ack = yes(flags, "ack");
        const bodyClipped = rung === "surface" && posts.some((p) => Buffer.byteLength(p.body) > SURFACE_BODY_BYTES);
        if (ack && (rung === "name" || rung === "children" || postId || since || posts.length < totalMatching || bodyClipped)) throw new Error("Cannot --ack an incomplete Thread read (name/children, --post, --since, bounded page or shortened body). Use: threads open <slug> --depth full --new --ack when the complete unread range fits one page.");
        const pin = str(flags, "pin");
        const position = str(flags, "position");
        if (flags.pin === true || flags.position === true) throw new Error("--pin and --position require values.");
        if (!!pin !== !!position) throw new Error("Pinned open requires both --pin <authored SHA> and --position <_threads/...md>.");
        if (pin && (flags.since !== undefined || flags.post !== undefined)) throw new Error("Pinned open already selects one authored position; omit --since and --post.");
        if (position && !position.startsWith(`_threads/${thread.slug}/`)) {
          throw new Error(`Pinned member ${position} belongs to another Thread; open its own local path instead.`);
        }
        const pinned = pin && position ? readPinnedThreadMember(threadBase(), pin, position) : undefined;
        if (pinned && parseThreadPost(pinned).status !== "valid" && !position?.endsWith("README.md")) throw new Error("Pinned post is invalid.");
        if (ack) acknowledge(thread, posts);
        const effectiveRung = postId ? "full" : rung;
        let parent: ThreadParentInfo | null = null;
        let parentWarning: string | undefined;
        try { parent = resolveThreadParent(thread.path); }
        catch (error) {
          parentWarning = `Thread ${thread.slug} parent cannot be read: ${error instanceof Error ? error.message : String(error)}`;
          output.log(parentWarning);
        }
        let childWarnings = 0;
        const warnChild = (message: string) => { output.log(message); childWarnings++; };
        let allChildThreads: ChildThreadInfo[] = [];
        if (postId || effectiveRung === "children") {
          try { allChildThreads = findChildThreads(thread.path, postId, warnChild); }
          catch (error) {
            warnChild(`Thread ${thread.slug} child lookup incomplete: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const allBranches = effectiveRung === "children" ? computeBranches(thread.posts).sort((a, b) => (b.tip_date ?? "").localeCompare(a.tip_date ?? "")) : [];
        if (effectiveRung === "children" && order === "older") { allChildThreads.reverse(); allBranches.reverse(); }
        const childThreads = allChildThreads.slice(0, limit ?? 10);
        const branches = allBranches.slice(0, limit ?? 10);
        const snapshot = findNewestSnapshot(thread.posts);

        // Surface keeps a bounded preview; full and --post retain exact bodies.
        const boundedPosts = !postId && effectiveRung === "surface"
          ? posts.map((p) => ({ ...p, body_truncated: Buffer.byteLength(p.body) > SURFACE_BODY_BYTES, body: Buffer.byteLength(p.body) > SURFACE_BODY_BYTES
            ? clip(p.body, SURFACE_BODY_BYTES, `… [body truncated; use --post ${p.id} for the complete post]`) : p.body })) : posts;
        const projected = effectiveRung === "name" || effectiveRung === "children" ? [] : boundedPosts.map((p) => effectiveRung === "summary"
          ? { id: p.id, path: p.path, kind: p.kind, date: p.date ?? null, name: p.frontmatter.name ?? p.id,
            summary: p.frontmatter.summary ?? null, in_reply_to: p.inReplyTo, author: p.frontmatter.author ?? null,
            ...(p.marks?.length ? { marks: p.marks } : {}), ...(p.frontmatter.tags?.length ? { tags: p.frontmatter.tags } : {}) }
          : p);
        const frame = effectiveRung === "name" ? threadFrame(thread) : undefined;
        const rawPost = postId && posts.length ? readFileSync(join(thread.path, posts[0].path), "utf8") : undefined;

        let humanText: string;
        if (pinned && effectiveRung === "full") {
          humanText = pinned;
        } else if (rawPost) {
          const marks = posts[0]?.marks;
          humanText = rawPost + (marks?.length ? `\nMarks: ${marks.map((m) => `${m.mark} (${m.author || "anonymous"})`).join(", ")}` : "");
          if (childThreads.length > 0) {
            humanText += `\n\nChild Threads (${childThreads.length} of ${allChildThreads.length} known):\n` + childThreads.map((c) => `  ${c.slug}  ${clip(c.name, 200)}\n    summary: ${clip(c.summary || "(no summary)", 200)}`).join("\n");
          }
          if (childWarnings) humanText += `\nChild Thread lookup incomplete: ${childWarnings} unreadable sibling(s).`;
        } else {
          humanText = localText(thread, boundedPosts, effectiveRung, {
            frame, parent, snapshot, branches, childThreads, branchTotal: allBranches.length, childThreadTotal: allChildThreads.length, childWarnings, filtered,
          });
        }

        if (parentWarning) humanText += `\nParent lookup incomplete: ${parentWarning}`;
        if (effectiveRung === "full" && !postId && posts.length < totalMatching) {
          const cursor = posts.at(-1)?.id;
          humanText += `\n\nShowing ${posts.length} of ${totalMatching} matching posts. ${order === "newer" ? "For forward paging, switch to --order older." : cursor ? `Continue with --since ${cursor} --order older.` : "Narrow the range with --since."}`;
        }
        output.result({ schema: "ideaspaces.local-thread.open.v3", thread: { path: thread.path, thread_id: thread.thread_id, name: thread.name, summary: effectiveRung === "name" ? undefined : thread.summary,
          closed: thread.closed, parent, warnings: thread.warnings, unreadable_posts: thread.unreadablePosts,
          ...(parentWarning ? { parent_warning: parentWarning } : {}),
          ...(effectiveRung === "summary" && snapshot ? { snapshot: { id: snapshot.id, kind: snapshot.kind, date: snapshot.date ?? null, name: snapshot.frontmatter.name ?? snapshot.id, summary: snapshot.frontmatter.summary ?? null, author: snapshot.frontmatter.author ?? null } } : {}),
          ...(frame ? { frame } : {}) }, posts: projected,
          ...(effectiveRung === "children" || postId ? { child_threads: childThreads, child_threads_total: allChildThreads.length, child_threads_complete: childWarnings === 0 } : {}),
          ...(effectiveRung === "children" ? { branches, branches_total: allBranches.length } : {}),
          ...(rawPost ? { raw_post: rawPost } : {}),
          ...(pinned ? { pinned: effectiveRung === "full" ? pinned : undefined, pin, position } : {}), shown: posts.length, matching: totalMatching, acknowledged: ack },
          humanText); return 0;
      }
      if (sub === "post" || sub === "close") {
        if (rest.length !== 1 || HOSTED.test(rest[0])) throw new Error(`Usage: threads ${sub} <local-path> [--message <body>]`);
        for (const flag of ["map", "reply-to", "kind", "mark", "author", "name", "summary", "supersedes", "message", "tags"]) {
          if (flags[flag] === true) throw new Error(`--${flag} requires a value.`);
        }
        if (sub === "close" && flags.kind !== undefined && flags.kind !== "closure") throw new Error("threads close always appends a closure post; omit --kind.");
        selectionFlags(flags);
        const kind = sub === "close" ? "closure" : str(flags, "kind") ?? "post";
        if (!kind.trim() || /[\r\n]/.test(kind)) throw new Error("--kind requires a non-empty single-line value (open kinds are supported).");
        if (!KNOWN_POST_KINDS.has(kind)) output.log(`Unrecognised post kind ${kind}; open kinds are valid, but check spelling before writing an immutable post.`);
        if (sub === "close" && (flags.member !== undefined || flags.checkout !== undefined)) throw new Error("Selected cross-Space close is not supported; use the local Space's close verb.");
        const map = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
        const selected = flags.member !== undefined
          ? selectPinnedThreadMember(map, str(flags, "member") ?? "") : undefined;
        if (!selected && flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        if (selected && flags.author !== undefined) throw new Error("Selected Thread posts use the caller's Agreement name; omit --author.");
        if (selected && kind === "closure") throw new Error("Selected cross-Space closure is not supported; use the local Space's close verb.");
        const parents = str(flags, "reply-to")?.split(",").map((id) => id.trim());
        if (parents?.some((id) => !id)) throw new Error("--reply-to must name non-empty post ids, separated by commas.");
        if (kind === "mark" && (!str(flags, "mark")?.trim() || parents?.length !== 1 || parents[0] === "latest")) {
          throw new Error("--kind mark requires --mark <value> and --reply-to <one explicit target post id>.");
        }
        if (flags.mark !== undefined && kind !== "mark") throw new Error("--mark requires --kind mark.");
        if (selected && !parents?.length) throw new Error("Selected post requires explicit --reply-to <post-id> at the authored pin.");
        const target = selected ? selectLocalThreadTarget(rest[0], selected.root, selected.member, str(flags, "checkout")) : undefined;
        const tags = typeof flags.tags === "string" ? flags.tags.split(",").map((t) => t.trim()) : undefined;

        const body = str(flags, "message") ?? await stdin();
        const { post, path } = appendPost(target?.thread.path ?? resolveLocalThread(rest[0]), { body, name: str(flags, "name"),
          summary: str(flags, "summary"), author: target ? selectedWriterName() : writerName(str(flags, "author")), replyTo: parents,
          kind: kind as ThreadKind, mark: str(flags, "mark"), supersedes: str(flags, "supersedes"), map, tags,
          rejectEscapedNewlines: typeof flags.message === "string", verifyTarget: target?.verifyWrite,
          onDefaultReplyTo: (id) => output.log(`Replying to opening post ${id}. Pass --reply-to <id> to answer a specific post, or --reply-to latest for newest.`) });
        output.result({ id: post.id, path, kind: post.kind, ...(post.mark ? { mark: post.mark } : {}), in_reply_to: post.inReplyTo }, `Appended ${post.kind}: ${path}`); return 0;
      }
      if (sub === "render") {
        if (rest.length !== 1) throw new Error("Usage: threads render <local-path>");
        const thread = loadThread(resolveLocalThread(rest[0]));
        reportThreadWarnings(thread, output);
        const timeline = thread.posts.map((post) => ({ id: post.id, name: post.frontmatter.name ?? post.id, kind: post.kind,
          date: post.date ?? null, in_reply_to: post.inReplyTo, path: post.path }));
        output.result({ path: thread.path, readme: thread.readme, timeline },
          `${thread.readme.trim()}\n\nTimeline (derived; README not overwritten):\n${timeline.map((p) => `- ${p.name} (${p.kind}) ${p.path}${p.in_reply_to.length ? ` ← ${p.in_reply_to.join(", ")}` : ""}`).join("\n")}`); return 0;
      }
      if (sub === "init") {
        if (rest.length) throw new Error("Usage: threads init");
        const path = initWorktree(); output.result({ path }, `Created isolated threads worktree: ${path}`); return 0;
      }
      if (sub === "push") {
        if (rest.length) throw new Error("Usage: threads push --remote <team-remote>");
        const remote = pushWorktree(process.cwd(), str(flags, "remote"));
        output.result({ remote }, `Pushed threads branch to ${remote}.`); return 0;
      }
      throw new Error(`Usage: ${threadsCommand.usage}`);
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  },
};
