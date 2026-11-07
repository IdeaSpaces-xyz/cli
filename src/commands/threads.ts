import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assembleContentReference, HOSTED_THREAD_ID, parseFrontmatter, parseThreadPost, renderContentFocus, THREAD_KINDS, type ContentFocusResult, type ContentRepresentation, type ThreadKind } from "@ideaspaces/protocol";
import { agreementFlag, preferredContractSource } from "../contract-source.js";
import { loadLocalThreadMap, selectPinnedThreadMember } from "../local/thread-map-member.js";
import { selectLocalThreadTarget } from "../local/cross-thread-target.js";
import { isHostAuth, peekConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef } from "../types.js";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import {
  acknowledge, appendPost, attachThread, createThread, initWorktree, listLocal, loadThread,
  pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread, threadBase, threadsDirectory, NoAgreementError,
  resolveThreadParent, findChildThreads, findNewestSnapshot, computeBranches, latestLocalActivity, validateMarkOptions, validateThreadMomentMap,
  isHostedThreadTarget, type LocalThread, type BranchInfo, type ChildThreadInfo, type ThreadParentInfo,
} from "../local/threads.js";
import { claimedBy, markText } from "../local/claims.js";
import { readThreadShare, shareLine, STATE_WORDS, type ThreadShare } from "../local/thread-state.js";
import { acknowledgeRecent, PERSON_READER, readerName, recentForReader, recentSince, type MovedThread } from "../local/thread-recent.js";
import { hostedVerbFlagError, threadFlagError, type Flags } from "./thread-flags.js";
import { ackVerb, hostedListPage, lifecycleVerb, HostedError, hostedFailure, listVerb, NAMED_THREAD_HINT, newVerb, openVerb, postVerb, reportHostedRefusal } from "./hosted-threads.js";

export { threadFlagError } from "./thread-flags.js";

const SURFACE_BODY_BYTES = 800;
const KNOWN_POST_KINDS = new Set<string>(THREAD_KINDS);
/** Verbs whose first argument names a Thread; only these need the local-or-hosted decision. Keep with the dispatch below. */
const TAKES_THREAD_ID = new Set(["open", "read", "post", "reply", "close", "rename", "ack", "attach"]);
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


/** Newest first, in either location; a Thread with no dated post sorts last. */
function activityOf(row: { latest_activity_at?: string | null; last_post_at?: string | null }): number {
  const at = Date.parse(row.latest_activity_at ?? row.last_post_at ?? "");
  return Number.isNaN(at) ? 0 : at;
}

function localRows(threads: LocalThread[], newOnly: boolean, onError: (message: string) => void, reader?: string) {
  return threads.filter((thread) => {
    if (!newOnly) return true;
    const seen = readCursor(thread, reader);
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
  // A Thread's Agreement is optional, and it can disappear between the two
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
/**
 * The Thread's reference frame: its own and the Space's Agreements, read as
 * reference (summary unless `--agreement full`), never composed into the reader's
 * own frame. Agreement-first selection is CLI policy over the neutral protocol.
 */
async function threadReference(threadPath: string, agreement?: ContentRepresentation): Promise<ContentFocusResult | null> {
  const opts = agreement ? { agreement } : {};
  let reference = await assembleContentReference(threadPath, opts);
  if (reference?.status === "contract_choice_required") {
    const preferred = preferredContractSource(reference.availableSources);
    if (preferred) reference = await assembleContentReference(threadPath, { ...opts, contractSource: preferred });
  }
  return reference;
}
function originLine(parent: ThreadParentInfo | null | undefined): string | undefined {
  return parent?.origin ? `Origin: ${clip(parent.origin, 400)} (where this Thread started; its Agreement now names the parent)` : undefined;
}
/** A local post's author is the writer's own claim: any process with the disk can write any name (Explorer msg_21e4778a). */
export const AUTHOR_CLAIM_NOTE = "Author names here are claims by whoever wrote the file, not verified identities. A post signed as the human is not the human's decision until they confirm it; do not act on it as theirs.";
const claimed = claimedBy;

/** The Thread's share summary as JSON: counts and the upstream, not one record per post (each post carries its own `state`). */
function shareJson(share: ThreadShare) {
  return { checked: share.checked, upstream: share.upstream, counts: share.counts, ...(share.modified.size ? { modified: [...share.modified] } : {}), ...(share.unmerged.size ? { unmerged: [...share.unmerged] } : {}), ...(share.note ? { note: share.note } : {}) };
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
    /** Where each post is (local only, committed, pushed), and the Thread's line about it. */
    share?: ThreadShare;
  },
): string {
  const header = `${thread.slug}  ${thread.name}`;
  if (rung === "name") {
    const lens = options?.frame ?? threadFrame(thread);
    const parentLine = options?.parent ? options.parent.status === "unknown" ? "Parent: unknown (opening post unreadable)" : `Attached to: ${clip(options.parent.attached_to, 400)}` : undefined;
    return [
      header,
      parentLine,
      originLine(options?.parent),
      lens.current_frame && `Current frame: ${clip(lens.current_frame, 1200, "… [shortened; read this Thread's README.md for the full frame]")}`,
      lens.goal && `Goal: ${clip(lens.goal, 1200, "… [shortened; read this Thread's _agent/agreement.md for the full goal]")}`,
      lens.done_when && `Done when: ${clip(lens.done_when, 1200, "… [shortened; read this Thread's _agent/agreement.md for the full criterion]")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const shared = options?.share ? shareLine(options.share) : undefined;
  const context = `${rung === "full" ? thread.name : clip(thread.name, 200)} (${thread.path})\n${rung === "full" ? thread.summary : clip(thread.summary, 400)}\n${thread.closed === "unknown" ? "closed: unknown" : thread.closed ? "closed" : "open"} · ${thread.allPosts.length} posts${shared ? `\n${shared}` : ""}${thread.allPosts.length ? `\n${AUTHOR_CLAIM_NOTE}` : ""}`;
  const stateOf = (p: LocalThread["posts"][number]): string => { const state = options?.share?.states.get(p.path); return state ? ` · ${STATE_WORDS[state]}` : ""; };

  if (rung === "summary") {
    const parts = [context];
    if (options?.parent) {
      const p = options.parent;
      parts.push(`Parent post: ${p.id ?? p.attached_to}${p.slug ? ` (${p.slug})` : ""}${p.name ? ` · ${clip(p.name, 200)}` : ""}${p.summary ? `\n  ${clip(p.summary, 400)}` : ""}`);
      const origin = originLine(p);
      if (origin) parts.push(origin);
    }
    if (options?.snapshot) {
      const s = options.snapshot;
      parts.push(`Latest snapshot: ${s.id} · ${s.kind} · ${s.date ?? "undated"} · ${clip(s.frontmatter.name ?? s.id, 200)} · ${claimed(s.frontmatter.author)}\n  ${clip(s.frontmatter.summary ?? "(no summary)", 400)}`);
    }
    if (options?.filtered && posts.length) {
      parts.push(
        posts
          .map(
            (p) =>
              `${p.id} · ${p.kind} · ${p.date ?? "undated"} · ${clip(p.frontmatter.name ?? p.id, 200)} · in_reply_to ${p.inReplyTo.join(", ") || "—"} · ${claimed(p.frontmatter.author)}${stateOf(p)}${p.marks?.length ? ` · marks: ${p.marks.map((m) => `${markText(m)}`).join(", ")}` : ""}\n  ${clip(p.frontmatter.summary ?? "(no summary)", 400)}`,
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
      const origin = originLine(options.parent);
      if (origin) parts.push(origin);
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
        `\n${p.id} · ${claimed(p.frontmatter.author)} · ${p.kind}${stateOf(p)}${p.inReplyTo.length ? ` ↳ ${p.inReplyTo.join(", ")}` : ""}${p.frontmatter.tags?.length ? ` · tags: ${p.frontmatter.tags.join(", ")}` : ""}\n${p.frontmatter.name ?? ""}\n${p.body}${p.marks?.length ? `\nMarks: ${p.marks.map((m) => `${markText(m)}`).join(", ")}` : ""}`,
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
  usage: "ideaspaces threads <list|recent|open|read|new|post|send|reply|ack|close|rename|locate|attach|render|init|push> ...",
  help: "For hosted new or send, --home map:<id> places the Thread in a hosted Space. Placement is not a grant and does not add a Map member. Local and remote Spaces remain independent; local Threads do not accept --home.",
  examples: [
    "ideaspaces threads capabilities --json  # integrations refuse a stale CLI before any remote call",
    "ideaspaces threads list [--new|--unread]  # local Threads plus all accessible hosted Threads; Unread is the web's count",
    "ideaspaces threads list --hosted [--limit 50] [--cursor <cursor>] [--unread]  # one page, no implicit ack",
    "ideaspaces threads open x_<id> [--limit 50] [--cursor <cursor>]  # read is an alias",
    "ideaspaces threads new --hosted --name 'Title' --summary 'One line' --message 'Opening' [--home map:<id>] [--recipients '@handle,email@example.org'] [--map context.map.md] [--tags label] [--post-id msg_id]",
    "ideaspaces threads send @handle [--home map:<id>] --name 'Title' --summary 'One line' --message 'Opening' [--map context.map.md] [--tags label]  # alias of new --hosted --recipients; to someone new it's a knock: text only, up to 1,000 characters, alone, and nobody posts until they let you in",
    "ideaspaces threads reply x_<id> --reply-to msg_parent --message 'Reply' [--map context.map.md] [--tags label] [--post-id msg_id]  # alias of post; old n_ parents are not accepted",
    "ideaspaces threads ack x_<id> --cursor <cursor from open>  # or --seq <n>; reading never acknowledges",
    "ideaspaces threads ack <slug|path> --through <post-id|latest> [--reader <name>]  # a local read position; other readers keep theirs",
    "ideaspaces threads recent [--cursor <cursor>] [--reader <name>] [--limit 50]  # which local Threads moved, ids and counts only; --cursor writes nothing; a reader's first look stores a baseline; the host may name the reader with IDEASPACES_READER",
    "ideaspaces threads ack --recent <cursor> [--reader <name>]  # move a reader's recent position; a look never does",
    "ideaspaces threads close x_<id> --message 'Why' [--post-id msg_id]  # preview; --yes appends a closure Note",
    "ideaspaces threads rename x_<id> --name 'Title' --summary 'One line' --message 'Why' [--post-id msg_id]  # appends a reframe Note",
    "ideaspaces threads list <directory>  # local only, no network",
    "ideaspaces threads new <slug> --about 'Title' [--attached-to post:msg_parent] [--map context.map.md]",
    "ideaspaces threads open <slug|path> [--depth name|summary|children|surface|full] [--post msg_id] [--limit 10] [--order older|newer] [--since msg_id] [--new] [--agreement full]  # each local post says local only, committed or pushed (Git, no network)",
    `ideaspaces threads post <slug|path> --message 'Decision' [--reply-to msg_id|latest] [--kind snapshot] [--author Name] [--tags ux] [--no-check-links]  # --kind is one of ${THREAD_KINDS.join(", ")}; a label goes in --tags`,
    "ideaspaces threads close <slug|path> --message 'Rationale'",
    "ideaspaces threads locate msg_opening <space-root> [<space-root> ...]",
    "ideaspaces threads attach <slug|path> post:msg_parent --message 'Why it moves'",
    "ideaspaces threads open <slug|path> --map context.map.md --member 0 [--checkout /path/to/root]  # pinned selection",
    "ideaspaces threads open <slug|path> --pin <sha> --position _threads/<slug>/<post>.md",
    "ideaspaces threads render <slug|path>",
    "ideaspaces threads init",
    "ideaspaces threads push --remote <team-remote>",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    try {
      if (sub === "capabilities") {
        if (rest.length || Object.keys(flags).length) throw new Error("Usage: threads capabilities --json");
        output.result({ schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: false }, "Hosted Threads use /threads only (no legacy exchange fallback).");
        return 0;
      }
      const hostedTarget = TAKES_THREAD_ID.has(sub ?? "") && isHostedThreadTarget(rest[0] ?? "");
      const hostedFlag = flags.hosted !== undefined;
      if (hostedFlag && flags.hosted !== true) throw new HostedError("invalid_request", "--hosted takes no value.");
      if (["posts", "expand", "add"].includes(sub ?? "")) throw new Error(`threads ${sub} retired with the Inbox; use threads list and open, or manage membership on the web.`);
      if ((sub === "list" || sub === "new") && hostedFlag || sub === "send" || hostedTarget && ["open", "read", "post", "reply", "close", "rename", "ack"].includes(sub ?? "")) {
        const hostedFlagError = hostedVerbFlagError(sub!, flags);
        if (hostedFlagError) throw new HostedError("invalid_request", hostedTarget ? `${hostedFlagError} ${NAMED_THREAD_HINT}` : hostedFlagError);
        if (sub === "list" || sub === "new") {
          if (rest.length) throw new HostedError("invalid_request", `threads ${sub} --hosted takes no positional target.`);
          return sub === "list" ? await listVerb(output, global.json, flags) : await newVerb(output, global.json, flags);
        }
        if (sub === "send") {
          if (rest.length !== 1) throw new HostedError("invalid_request", "Usage: threads send <@handle|email> --name <title> --summary <summary> --message <opening> [--map <Map>]");
          return await newVerb(output, global.json, { ...flags, recipients: rest[0] });
        }
        if (rest.length !== 1 || !hostedTarget) throw new HostedError("invalid_request", `threads ${sub} needs a hosted x_ Thread id.`);
        if (sub === "post" || sub === "reply") return await postVerb(output, global.json, rest[0], flags);
        if (sub === "ack") return await ackVerb(output, global.json, rest[0], flags);
        if (sub === "close" || sub === "rename") return await lifecycleVerb(output, global.json, rest[0], sub, flags, global.yes);
        return await openVerb(output, global.json, rest[0], flags);
      }
      const flagError = threadFlagError(sub ?? "", flags);
      if (flagError) throw new Error(flagError);
      if (sub === "read") return threadsCommand.run(["open", ...rest], flags, global);
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
      if (sub === "recent") {
        if (rest.length) throw new Error("Usage: threads recent [--cursor <cursor>] [--reader <name>] [--limit <n>]");
        if (flags.cursor === true || flags.reader === true) throw new Error("--cursor and --reader require a value.");
        if (flags.cursor !== undefined && flags.reader !== undefined) throw new Error("Use --cursor or --reader, not both: a cursor is the position you hold, a reader is one held for you.");
        const limit = flags.limit === undefined ? 50 : Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be a whole number from 1 to 500.");
        const root = threadBase();
        const reader = flags.cursor === undefined ? readerName(str(flags, "reader")) : undefined;
        const result = reader ? recentForReader(root, threadsDirectory(), reader, limit) : recentSince(root, threadsDirectory(), str(flags, "cursor"), limit);
        const shown = result.threads;
        const label = (row: MovedThread) => `${row.slug}  ${row.new_thread ? `new Thread, ${row.new_posts} posts` : row.new_posts ? `${row.new_posts} new` : "changed"}`;
        const lines = result.baseline
          ? [`Baseline set${reader ? ` for ${reader}` : ""}: nothing new yet. Later reads show what moved after this point.`]
          : shown.length ? shown.map(label) : ["Nothing moved."];
        if (shown.length < result.moved) lines.push(`Showing ${shown.length} of ${result.moved} Threads that moved; the rest stay new.`);
        if (reader && !result.baseline && shown.length) lines.push(`Move ${reader}'s position past what is shown here: ideaspaces threads ack --recent ${result.cursor}${reader === PERSON_READER ? "" : ` --reader ${reader}`}`);
        output.result({ schema: "ideaspaces.threads.recent.v1", location: "folder", hosted_checked: false, baseline: result.baseline, ...(reader ? { reader } : {}),
          threads: shown, moved: result.moved, shown: shown.length, cursor: result.cursor }, lines.join("\n"));
        return 0;
      }
      if (sub === "ack") {
        for (const flag of ["through", "recent", "reader"]) if (flags[flag] === true) throw new Error(`--${flag} requires a value.`);
        const reader = readerName(str(flags, "reader"));
        if (flags.recent !== undefined) {
          if (rest.length || flags.through !== undefined) throw new Error("Usage: threads ack --recent <cursor> [--reader <name>]");
          acknowledgeRecent(threadBase(), reader, str(flags, "recent")!);
          output.result({ schema: "ideaspaces.threads.recent-ack.v1", reader, cursor: str(flags, "recent") }, `Moved ${reader}'s recent position.`);
          return 0;
        }
        const usage = "Usage: threads ack <slug|path> --through <post-id|latest> [--reader <name>]";
        if (rest.length !== 1) throw new Error(usage);
        const through = str(flags, "through");
        if (!through) throw new Error(`Say how far you read, so nothing unseen is marked read. ${usage}`);
        const thread = loadThread(resolveLocalThread(rest[0]));
        const at = through === "latest" ? thread.posts.length - 1 : thread.posts.findIndex((post) => post.id === through);
        if (at < 0) throw new Error(through === "latest" ? "This Thread has no posts to acknowledge." : `Post ${through} is not in this Thread's timeline.`);
        const posts = thread.posts.slice(0, at + 1);
        acknowledge(thread, posts, reader);
        output.result({ schema: "ideaspaces.local-thread.ack.v1", path: thread.path, reader, position: posts[at].id, acknowledged: posts.length },
          `Marked ${posts.length} posts read for ${reader}, through ${posts[at].id}.`);
        return 0;
      }
      if (sub === "list") {
        if (flags.depth === "children" || flags.depth === "surface") throw new Error("threads list supports name, summary or full; use threads open for a Thread rung.");
        if (rest.length > 1 || (rest.length && str(flags, "space"))) throw new Error("Usage: threads list [<dir>] [--new|--unread] (or --hosted --limit <n> --cursor <cursor>)");
        if (flags.limit !== undefined || flags.cursor !== undefined) throw new HostedError("invalid_request", "--limit and --cursor on list require --hosted; use threads list <directory> for local-only listing.");
        const newOnly = yes(flags, "new") || yes(flags, "unread");
        const rung = depth(flags, "summary");
        const space = str(flags, "space");
        if (space || flags.kind !== undefined || flags.since !== undefined) throw new Error("Inbox list filters retired; use threads list --hosted [--unread] [--cursor <cursor>] or an explicit local directory.");
        if ((flags.limit !== undefined || flags.cursor !== undefined || flags.unread !== undefined) && rest.length) throw new Error("Hosted list paging and --unread cannot be combined with a local directory.");
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
            local = localRows(localThreads, newOnly, warn, readerName(str(flags, "reader")));
          } catch (error) {
            // Outside a Space, hosted listing still works. A malformed Thread or
            // cursor inside a Space is not an empty list — fail visibly.
            if (rest.length || !(error instanceof NoAgreementError)) throw error;
          }
        }
        const config = peekConfig();

        let hosted: Array<{ source: "hosted"; id: string; name: string; summary?: string; closed: boolean; unread_count: number; last_post_at?: string | null }> = [];
        let hostedChecked = false;
        let hostedError: string | undefined;
        if (config && !rest.length) {
          try {
            // Default list drains all pages so --new/--unread includes the whole account.
            // Explicit cursor/limit paging is available through list --hosted.
            let cursor: string | undefined;
            const seen = new Set<string>();
            do {
              if (seen.size >= 100) throw new HostedError("invalid_response", "Hosted list exceeded 100 pages; use threads list --hosted with cursor paging. No complete Unread list is claimed.");
              const page = await hostedListPage(config, { limit: 200, ...(cursor ? { cursor } : {}) });
              hosted.push(...page.threads.filter((t: any) => !(newOnly || flags.unread) || t.unread_count > 0).map((t: any) => ({ ...t, source: "hosted" as const })));
              cursor = page.next_cursor ?? undefined;
              if (cursor && seen.has(cursor)) throw new HostedError("invalid_response", "Service repeated a Thread list cursor; listing is incomplete.");
              if (cursor) seen.add(cursor);
            } while (cursor);
            hostedChecked = true;
          } catch (error) {
            if (!local.length) throw hostedFailure(error);
            hostedError = error instanceof Error ? error.message : String(error);
            hosted = []; // Never render a partial account list alongside healthy local rows.
            output.log(`Hosted Threads unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const rows = [...local, ...hosted].filter((row) => !yes(flags, "open") || row.closed !== true).sort((a, b) => activityOf(b) - activityOf(a)).map((row) => {
          if (rung === "name") return { source: row.source, id: row.id, name: row.name,
            ...(row.source === "local" ? { closed: row.closed, slug: row.slug, thread_id: row.thread_id, latest_activity_at: row.latest_activity_at, parent: row.parent } : { unread_count: row.unread_count, ...(row.closed !== undefined ? { closed: row.closed } : {}) }) };
          if (rung === "full" && row.source === "local") {
            return { ...row, posts: localThreads.find((thread) => thread.path === row.id)?.posts ?? [] };
          }
          return row;
        });
        const text = rows.map((row) => {
          if (rung === "name") return `${row.id}  ${row.name}${(row.closed === true ? " · closed" : "") + ("unread_count" in row && row.unread_count ? ` · ${row.unread_count} unread` : "")}${"closed" in row && row.closed === "unknown" ? " · closed: unknown" : ""}`;
          if (rung === "full" && "posts" in row && Array.isArray(row.posts)) {
            const thread = localThreads.find((candidate) => candidate.path === row.id)!;
            return localText(thread, row.posts, "full");
          }
          if (rung === "full" && "text" in row && typeof row.text === "string") return row.text;
          return `${row.id}  ${row.name}${(row.closed === true ? " · closed" : "") + ("unread_count" in row && row.unread_count ? ` · ${row.unread_count} unread` : "")}${"closed" in row && row.closed === "unknown" ? " · closed: unknown" : ""}\n  ${"summary" in row ? row.summary : ""} · ${row.source}`;
        }).join("\n\n");
        const hint = !config && !rest.length ? isHostAuth()
          ? "\nHosted Threads not checked: remote work is coming through the IdeaSpaces tools."
          : "\nHosted Threads not checked (not logged in; run `ideaspaces login`)." : "";
        output.result({ schema: "ideaspaces.threads.list.v2", threads: rows, hosted_checked: hostedChecked, ...(hostedError ? { hosted_error: hostedError } : {}), local_complete: localWarnings === 0 }, (text || "No local Threads here.") + (hostedError ? `\nHosted Threads unavailable: ${hostedError}` : "") + (localWarnings ? `\nLocal Thread listing incomplete: ${localWarnings} unreadable item(s).` : "") + hint);
        return newOnly && hostedError ? 1 : 0;
      }
      if (sub === "new") {
        if (rest.length !== 1 || !str(flags, "about")) throw new Error("Usage: threads new <slug> --about <title> [--attached-to <type>:<id>] [--map <pinned-note>]");
        const attachedTo = str(flags, "attached-to");
        if (flags["attached-to"] === true) throw new Error("--attached-to requires a <type>:<id> value. No Thread created.");
        if (flags.map !== undefined && !str(flags, "map")?.trim()) throw new Error("--map requires a pinned moment Map note; no Thread created.");
        const openingMap = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
        if (openingMap !== undefined) validateThreadMomentMap(openingMap); // Before createThread mutates the folder.
        const thread = createThread(rest[0], str(flags, "about")!, process.cwd(), attachedTo);
        let opening: ReturnType<typeof appendPost>;
        try {
          opening = appendPost(thread.path, { body: str(flags, "about")!, name: thread.name, summary: thread.summary, attachedTo, map: openingMap });
        } catch (err) {
          throw new Error(`Thread created at ${thread.path}, but opening post was not written: ${err instanceof Error ? err.message : String(err)}. Use threads post ${thread.slug} --message <opening-text> to complete it; do not rerun threads new.`);
        }
        output.result({ path: thread.path, slug: thread.slug, thread_id: opening.post.id, opening_post_id: opening.post.id, date: opening.post.date,
          ...(attachedTo ? { attached_to: attachedTo } : {}) },
          `Created local Thread: ${thread.path}`); return 0;
      }
      if (sub === "open") {
        if (rest.length !== 1) throw new Error("Usage: threads open <path|x_id> [--depth name|summary|children|surface|full] [--post <id>] [--since <date|id>] [--limit <n>] [--order newer|older] [--new] [--ack]");
        if (hostedTarget && flags.agreement !== undefined) throw new Error("--agreement applies to local Threads; a hosted Thread's terms are kept by the service.");

        const referenceSelection = agreementFlag(flags.agreement);
        if (referenceSelection.error) throw new Error(referenceSelection.error);
        // Every pinned read refuses --agreement the same way, before the Thread is resolved.
        if (flags.map !== undefined && flags.agreement !== undefined) throw new Error("--agreement reads the live reference frame; a selected pinned read carries none. Omit --agreement with --map.");
        const pinnedRead = flags.pin !== undefined || flags.position !== undefined;
        if (pinnedRead && flags.agreement !== undefined) throw new Error("--agreement reads the live reference frame; a pinned read carries none. Omit --agreement with --pin.");
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
        // The Thread's terms arrive with every read of it, as reference: a dispatched agent reading
        // one post learns the Thread's name and terms, and where to read them in full.
        const reference = pinnedRead ? null : await threadReference(thread.path, referenceSelection.agreement);
        const referenceDiagnostic = reference && reference.status !== "ok" ? renderContentFocus(reference) : undefined;
        if (referenceDiagnostic) output.log(`Thread ${thread.slug} reference frame unavailable: ${referenceDiagnostic}`);
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
        const reader = readerName(str(flags, "reader"));
        const seen = newOnly ? readCursor(thread, reader) : new Set<string>();
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
        if (ack) acknowledge(thread, posts, reader);
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
        // Where the posts are ("posted" is not "delivered"): at most six Git calls and eight seconds in all, never the network. A name read shows no posts.
        const share = effectiveRung === "name" ? undefined : readThreadShare(thread.path, thread.allPosts.map((post) => post.path));
        const stateField = (post: { path: string }) => { const state = share?.states.get(post.path); return state ? { state } : {}; };
        const boundedPosts = !postId && effectiveRung === "surface"
          ? posts.map((p) => ({ ...p, body_truncated: Buffer.byteLength(p.body) > SURFACE_BODY_BYTES, body: Buffer.byteLength(p.body) > SURFACE_BODY_BYTES
            ? clip(p.body, SURFACE_BODY_BYTES, `… [body truncated; use --post ${p.id} for the complete post]`) : p.body })) : posts;
        const projected = effectiveRung === "name" || effectiveRung === "children" ? [] : boundedPosts.map((p) => effectiveRung === "summary"
          ? { id: p.id, path: p.path, kind: p.kind, date: p.date ?? null, name: p.frontmatter.name ?? p.id,
            summary: p.frontmatter.summary ?? null, in_reply_to: p.inReplyTo, author: p.frontmatter.author ?? null,
            ...stateField(p), ...(p.marks?.length ? { marks: p.marks } : {}), ...(p.frontmatter.tags?.length ? { tags: p.frontmatter.tags } : {}) }
          : { ...p, ...stateField(p) });
        const frame = effectiveRung === "name" ? threadFrame(thread) : undefined;
        const rawPost = postId && posts.length ? readFileSync(join(thread.path, posts[0].path), "utf8") : undefined;

        let humanText: string;
        if (pinned && effectiveRung === "full") {
          humanText = pinned;
        } else if (rawPost) {
          const marks = posts[0]?.marks;
          const rawState = share?.states.get(posts[0].path);
          humanText = rawPost + (marks?.length ? `\nMarks: ${marks.map((m) => `${markText(m)}`).join(", ")}` : "")
            + (rawState ? `\nState: ${STATE_WORDS[rawState]}${share?.modified.has(posts[0].path) ? "; this file was changed after it was committed" : ""}` : "");
          if (childThreads.length > 0) {
            humanText += `\n\nChild Threads (${childThreads.length} of ${allChildThreads.length} known):\n` + childThreads.map((c) => `  ${c.slug}  ${clip(c.name, 200)}\n    summary: ${clip(c.summary || "(no summary)", 200)}`).join("\n");
          }
          if (childWarnings) humanText += `\nChild Thread lookup incomplete: ${childWarnings} unreadable sibling(s).`;
        } else {
          humanText = localText(thread, boundedPosts, effectiveRung, {
            frame, parent, snapshot, branches, childThreads, branchTotal: allBranches.length, childThreadTotal: allChildThreads.length, childWarnings, filtered, share,
          });
        }

        if (parentWarning) humanText += `\nParent lookup incomplete: ${parentWarning}`;
        // A name read orients: the Agreement line stays, the Space's skills do not, and the CLI has no session to show them once.
        const focus = reference?.status === "ok" && effectiveRung === "name" ? { ...reference, skills: [] } : reference;
        if (focus?.status === "ok") humanText = `${renderContentFocus(focus)}\n\n${humanText}`;
        if (effectiveRung === "full" && !postId && posts.length < totalMatching) {
          const cursor = posts.at(-1)?.id;
          humanText += `\n\nShowing ${posts.length} of ${totalMatching} matching posts. ${order === "newer" ? "For forward paging, switch to --order older." : cursor ? `Continue with --since ${cursor} --order older.` : "Narrow the range with --since."}`;
        }
        output.result({ schema: "ideaspaces.local-thread.open.v4", ...(focus?.status === "ok" ? { reference: focus } : {}), ...(referenceDiagnostic ? { reference_diagnostic: referenceDiagnostic } : {}), thread: { path: thread.path, thread_id: thread.thread_id, name: thread.name, summary: effectiveRung === "name" ? undefined : thread.summary,
          closed: thread.closed, parent, warnings: thread.warnings, unreadable_posts: thread.unreadablePosts,
          ...(share ? { share: shareJson(share) } : {}), author_trust: "claimed", author_note: AUTHOR_CLAIM_NOTE,
          ...(parentWarning ? { parent_warning: parentWarning } : {}),
          ...(effectiveRung === "summary" && snapshot ? { snapshot: { id: snapshot.id, kind: snapshot.kind, date: snapshot.date ?? null, name: snapshot.frontmatter.name ?? snapshot.id, summary: snapshot.frontmatter.summary ?? null, author: snapshot.frontmatter.author ?? null } } : {}),
          ...(frame ? { frame } : {}) }, posts: projected,
          ...(effectiveRung === "children" || postId ? { child_threads: childThreads, child_threads_total: allChildThreads.length, child_threads_complete: childWarnings === 0 } : {}),
          ...(effectiveRung === "children" ? { branches, branches_total: allBranches.length } : {}),
          ...(rawPost ? { raw_post: rawPost } : {}),
          ...(pinned ? { pinned: effectiveRung === "full" ? pinned : undefined, pin, position } : {}), shown: posts.length, matching: totalMatching, acknowledged: ack },
          humanText); return 0;
      }
      if (sub === "attach") {
        const usage = "Usage: threads attach <slug|path> <post:msg_…|msg_…|_threads/<thread>/<post>.md> --message <why>";
        if (rest.length !== 2) throw new Error(usage);
        if (hostedTarget) {
          throw new Error("threads attach moves local Threads only; a hosted Thread's parent is kept by the service.");
        }
        for (const flag of ["message", "author"]) if (flags[flag] === true) throw new Error(`--${flag} requires a value.`);
        // A one-line reason, never stdin: a move without a stated reason is refused before anything is read.
        const message = str(flags, "message") ?? "";
        if (!message.trim()) throw new Error(`--message is required: say why the Thread moves. ${usage}`);
        const result = attachThread(resolveLocalThread(rest[0]), rest[1], { message, author: writerName(str(flags, "author")) });
        if (result.cycleCheckSkipped.length) {
          output.log(`Cycle check skipped ${result.cycleCheckSkipped.length} Thread(s) whose parent cannot be read: ${result.cycleCheckSkipped.join(", ")}. A cycle through them is not ruled out; once they read again, \`threads open <slug> --depth summary\` shows each parent.`);
        }
        const previous = result.previous ? `${result.previous.id ?? result.previous.attached_to}${result.previous.slug ? ` (${result.previous.slug})` : ""}` : "none";
        output.result({
          path: result.thread.path, slug: result.thread.slug,
          previous_parent: result.previous,
          parent: result.parent,
          origin: result.thread.origin === null ? null : result.thread.origin === "unknown" ? "unknown" : result.thread.origin.raw ?? result.thread.origin.value,
          agreement_path: result.agreementPath, agreement_created: result.agreementCreated,
          reframe: { id: result.post.id, path: result.postPath, in_reply_to: result.post.inReplyTo },
          cycle_check_skipped: result.cycleCheckSkipped,
        }, [
          `Attached ${result.thread.slug} under ${result.parent.id} · ${result.parent.name} (${result.parent.slug}).`,
          `  previous parent: ${previous}`,
          `  Agreement: ${result.agreementPath}${result.agreementCreated ? " (created: this Thread had none; it now carries the minimal Agreement threads new writes)" : " (attached_to only; every other line kept)"}`,
          `  reframe: ${result.postPath}`,
        ].join("\n"));
        return 0;
      }
      if (sub === "post" || sub === "close") {
        if (rest.length !== 1 || hostedTarget) throw new Error(`Usage: threads ${sub} <local-path> [--message <body>]`);
        for (const flag of ["map", "reply-to", "kind", "mark", "author", "name", "summary", "supersedes", "message", "tags"]) {
          if (flags[flag] === true) throw new Error(`--${flag} requires a value.`);
        }
        if (sub === "close" && flags.kind !== undefined && flags.kind !== "closure") throw new Error("threads close always appends a closure post; omit --kind.");
        // _threads/ arrives by clone, so a folder may carry an id someone means on the service: a write says which it took.
        if (HOSTED_THREAD_ID.test(rest[0])) output.log(`${rest[0]} is a folder in this Space's _threads/, so this writes there. To reach a hosted Thread of that id, run it outside this Space.`);
        selectionFlags(flags);
        const kind = sub === "close" ? "closure" : str(flags, "kind") ?? "post";
        if (!KNOWN_POST_KINDS.has(kind)) {
          throw new Error(`--kind ${JSON.stringify(kind)} is not a kind: use ${THREAD_KINDS.join(", ")}. A label for a post goes in --tags.`);
        }
        if (sub === "close" && (flags.member !== undefined || flags.checkout !== undefined)) throw new Error("Selected cross-Space close is not supported; use the local Space's close verb.");
        const map = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
        const selected = flags.member !== undefined
          ? selectPinnedThreadMember(map, str(flags, "member") ?? "") : undefined;
        if (!selected && flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        if (selected && flags.author !== undefined) throw new Error("Selected Thread posts use the caller's Agreement name; omit --author.");
        if (selected && kind === "closure") throw new Error("Selected cross-Space closure is not supported; use the local Space's close verb.");
        const parents = str(flags, "reply-to")?.split(",").map((id) => id.trim());
        if (parents?.some((id) => !id)) throw new Error("--reply-to must name non-empty post ids, separated by commas.");
        validateMarkOptions(kind, str(flags, "mark"), parents);
        if (selected && !parents?.length) throw new Error("Selected post requires explicit --reply-to <post-id> at the authored pin.");
        const target = selected ? selectLocalThreadTarget(rest[0], selected.root, selected.member, str(flags, "checkout")) : undefined;
        const tags = typeof flags.tags === "string" ? flags.tags.split(",").map((t) => t.trim()) : undefined;

        const body = str(flags, "message") ?? await stdin();
        const { post, path, warnings } = appendPost(target?.thread.path ?? resolveLocalThread(rest[0]), { body, checkLinks: flags["no-check-links"] !== true, name: str(flags, "name"),
          summary: str(flags, "summary"), author: target ? selectedWriterName() : writerName(str(flags, "author")), replyTo: parents,
          kind: kind as ThreadKind, mark: str(flags, "mark"), supersedes: str(flags, "supersedes"), map, tags,
          rejectEscapedNewlines: typeof flags.message === "string", verifyTarget: target?.verifyWrite,
          onDefaultReplyTo: (id) => output.log(`Replying to opening post ${id}. Pass --reply-to <id> to answer a specific post, or --reply-to latest for newest.`) });
        for (const warning of warnings) output.log(`Link warning: ${warning}`);
        const postShare = readThreadShare(dirname(path), [basename(path)]);
        const posted = postShare.states.get(basename(path));
        output.result({ id: post.id, path, kind: post.kind, ...(post.mark ? { mark: post.mark } : {}), in_reply_to: post.inReplyTo, ...(posted ? { state: posted } : {}), ...(warnings.length ? { warnings } : {}) },
          `Appended ${post.kind}: ${path}${posted === "local" ? (postShare.inRepository ? "\nState: local only. The file is on this disk and not committed; commit and push it for anyone else to read it." : "\nState: local only. This folder is not in a Git repository, so there is nothing to commit or push here; the file is on this disk only.") : ""}`); return 0;
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
      const refused = reportHostedRefusal(error, output, global.json);
      if (refused !== undefined) return refused;
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  },
};
