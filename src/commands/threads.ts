import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter, parseThreadPost, type ThreadKind } from "@ideaspaces/protocol";
import { loadLocalThreadMap, selectPinnedThreadMember } from "../local/thread-map-member.js";
import { selectLocalThreadTarget } from "../local/cross-thread-target.js";
import { apiErrorDetail, fetchExchange, fetchInbox, fetchSpaceThreads, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef } from "../types.js";
import { exchangeText, hostedThreadsCommand } from "./inbox.js";
import { sanitizedGitEnvironment } from "../git.js";
import {
  acknowledge, appendPost, createThread, initWorktree, listLocal, loadThread,
  pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread, threadBase, NoAgreementError,
  type LocalThread,
} from "../local/threads.js";

const HOSTED = /^x_[0-9a-f]{24}$/;
const KINDS = new Set(["post", "snapshot", "reframe", "correction", "closure"]);
type Flags = Record<string, string | boolean>;
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
function depth(flags: Flags, fallback: string): "name" | "summary" | "full" {
  const value = flags.depth ?? fallback;
  if (value === "name" || value === "summary" || value === "full") return value;
  throw new Error("--depth must be name, summary or full.");
}
async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
/** CLI-local list presentation over protocol date/fileDate metadata. The
 * protocol defines their precedence; the CLI owns its local Thread activity row. */
function activityAt(post: LocalThread["posts"][number]): string | null {
  if (post.dateWarning || !post.date) return null;
  return post.date.length === 10 ? post.fileDate ?? post.date : post.date;
}

function latestLocalActivity(posts: LocalThread["posts"]): string | null {
  return posts.reduce<string | null>((latest, post) => {
    const at = activityAt(post);
    const time = at ? Date.parse(at) : NaN;
    return Number.isFinite(time) && (!latest || time > Date.parse(latest)) ? at : latest;
  }, null);
}

function localRows(threads: LocalThread[], newOnly: boolean) {
  return threads.filter((thread) => {
    if (!newOnly) return true;
    const seen = readCursor(thread);
    return thread.posts.some((post) => !seen.has(post.id));
  }).map((thread) => ({ source: "local" as const, id: thread.path, slug: thread.slug, name: thread.name,
    summary: thread.summary, count: thread.posts.length, closed: thread.closed,
    latest_activity_at: latestLocalActivity(thread.posts) }));
}
function reportDateWarnings(thread: LocalThread, output: Output): void {
  for (const warning of new Set(thread.warnings)) output.log(`Thread ${thread.slug}: ${warning}`);
}

function localText(thread: LocalThread, posts: LocalThread["posts"], rung: string): string {
  if (rung === "name") return `${thread.slug}  ${thread.name}`;
  const header = `${thread.name} (${thread.path})\n${thread.summary}\n${thread.closed ? "closed" : "open"} · ${thread.posts.length} posts`;
  return [header, ...posts.map((p) => rung === "summary"
    ? `\n${p.frontmatter.name ?? p.id} — ${p.frontmatter.summary ?? p.body.split("\n").find(Boolean) ?? ""}`
    : `\n${p.id} · ${p.frontmatter.author ?? "unknown author"} · ${p.kind}${p.inReplyTo.length ? ` ↳ ${p.inReplyTo.join(", ")}` : ""}\n${p.frontmatter.name ?? ""}\n${p.body}`),
  ].join("\n");
}
function selectedWriterName(): string {
  const cwd = realpathSync(process.cwd());
  const prefix = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8", env: sanitizedGitEnvironment() });
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
  const result = spawnSync("git", ["config", "user.name"], { cwd: process.cwd(), encoding: "utf8", env: sanitizedGitEnvironment() });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  throw new Error("No writer identity. Pass --author <name> (or set git user.name / run from an agent Agreement).");
}
export const threadsCommand: CommandDef = {
  name: "threads",
  description: "List, read and write local or hosted Threads (local posts stay in Git)",
  usage: "ideaspaces threads <list|open|new|post|close|rename|add|render|init|push|read|send|reply|expand> ...",
  examples: [
    "ideaspaces threads list [<dir>] [--new] [--space n_…]",
    "ideaspaces threads open <slug|path|x_id> [--depth name|summary|full] [--new] [--ack]",
    "ideaspaces threads new <slug> --about 'What we are deciding'  # writes opening post; counts as unread until ack",
    "ideaspaces threads read <local-slug|path> --json  # alias of open, includes post dates",
    "ideaspaces threads post <slug|path> --message 'Decision' [--reply-to id1,id2] [--kind snapshot] [--map selection.json]",
    "ideaspaces threads post <slug> --message 'Decision' --map home.map.md --member 0 --reply-to msg_id [--checkout /absolute/space/root]",
    "ideaspaces threads open <slug|path> --map home.map.md --member 0  # same-Space authored pin",
    "ideaspaces threads open <slug> --map home.map.md --member 0 [--checkout /absolute/space/root]  # selected pin only",
    "ideaspaces threads open <slug|path> --pin <40-hex-sha> --position _threads/<slug>/<post>.md",
    "ideaspaces threads close <slug|path> --message 'Closing rationale'  # local",
    "ideaspaces threads close x_<id>  # hosted owner",
    "ideaspaces threads add x_<id> @handle --grade view  # hosted owner",
    "ideaspaces threads rename x_<id> --name 'New title'  # hosted owner",
    "ideaspaces threads send @handle --grade view --name 'Question' --summary 'One decision' --message '…'",
    "ideaspaces threads list --kind message --json  # hosted rows include your_grade",
    "ideaspaces threads render <slug|path>  # derived timeline; README stays curated",
    "ideaspaces threads init  # isolated orphan threads worktree at _threads/",
    "ideaspaces threads push --remote <team-remote>  # never origin/GitHub",
    "ideaspaces threads read x_<id> --new --ack  # hosted",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    try {
      if (sub === "read" || sub === "send" || sub === "reply" || sub === "expand" || sub === "add" || sub === "rename" || (sub === "close" && rest.length === 1 && HOSTED.test(rest[0]))) {
        if (sub === "read" && rest.length === 1 && !HOSTED.test(rest[0])) {
          return threadsCommand.run(["open", rest[0]], flags, global);
        }
        return hostedThreadsCommand.run(args, flags, global);
      }
      if (sub === "list") {
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
        if (!space) {
          try {
            localThreads = listLocal(cwd);
            for (const thread of localThreads) reportDateWarnings(thread, output);
            local = localRows(localThreads, newOnly);
          } catch (error) {
            // Outside a Space, hosted listing still works. A malformed Thread or
            // cursor inside a Space is not an empty list — fail visibly.
            if (rest.length || !(error instanceof NoAgreementError)) throw error;
          }
        }
        const config = loadConfig();
        if (space && !config) throw new Error("Not logged in. Run `ideaspaces login` to list hosted Space Threads.");
        let hosted: Array<{ source: "hosted"; id: string; name: string; summary: string; your_grade?: string; closed?: boolean; count?: number; messages?: unknown[]; text?: string }> = [];
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
            ...(row.source === "local" ? { latest_activity_at: row.latest_activity_at } : { your_grade: row.your_grade, closed: row.closed }) };
          if (rung === "full" && row.source === "local") {
            return { ...row, posts: localThreads.find((thread) => thread.path === row.id)?.posts ?? [] };
          }
          return row;
        });
        const text = rows.map((row) => {
          if (rung === "name") return `${row.id}  ${row.name}`;
          if (rung === "full" && "posts" in row && Array.isArray(row.posts)) {
            const thread = localThreads.find((candidate) => candidate.path === row.id)!;
            return localText(thread, row.posts, "full");
          }
          if (rung === "full" && "text" in row && typeof row.text === "string") return row.text;
          return `${row.id}  ${row.name}\n  ${"summary" in row ? row.summary : ""} · ${row.source}`;
        }).join("\n\n");
        const hint = !config && !rest.length ? "\nHosted Threads not checked (not logged in; run `ideaspaces login`)." : "";
        output.result({ threads: rows, hosted_checked: Boolean(config) }, (text || "No local Threads here.") + hint);
        return 0;
      }
      if (sub === "new") {
        if (rest.length !== 1 || !str(flags, "about")) throw new Error("Usage: threads new <slug> --about <title>");
        const thread = createThread(rest[0], str(flags, "about")!);
        let opening: ReturnType<typeof appendPost>;
        try {
          opening = appendPost(thread.path, { body: str(flags, "about")!, name: thread.name, summary: thread.summary });
        } catch (err) {
          throw new Error(`Thread created at ${thread.path}, but opening post was not written: ${err instanceof Error ? err.message : String(err)}. Use threads post ${thread.slug} --message <opening-text> to complete it; do not rerun threads new.`);
        }
        output.result({ path: thread.path, slug: thread.slug, opening_post_id: opening.post.id, date: opening.post.date },
          `Created local Thread: ${thread.path}`); return 0;
      }
      if (sub === "open") {
        if (rest.length !== 1) throw new Error("Usage: threads open <path|x_id> [--depth name|summary|full] [--new] [--ack]");
        if (HOSTED.test(rest[0])) return hostedThreadsCommand.run(["read", rest[0]], flags, global);
        selectionFlags(flags);
        if (flags.map !== undefined && flags.member === undefined) throw new Error("Pinned open with --map requires --member <zero-based ordinal>; no live HEAD fallback.");
        if (flags.map !== undefined && flags.member !== undefined) {
          if (flags.pin !== undefined || flags.position !== undefined) throw new Error("Use either --map with --member or --pin with --position, not both.");
          if (flags.new !== undefined || flags.ack !== undefined) throw new Error("Selected pinned reads cannot use live --new or --ack.");
          const { root, member } = selectPinnedThreadMember(loadLocalThreadMap(str(flags, "map") ?? ""), str(flags, "member") ?? "");
          const target = selectLocalThreadTarget(rest[0], root, member, str(flags, "checkout"));
          const rung = depth(flags, "summary");
          const post = target.post;
          const postName = post.frontmatter.name ?? post.id;
          const postSummary = post.frontmatter.summary ?? post.body.split("\n").find(Boolean) ?? "";
          const posts = rung === "name" ? [] : rung === "summary" ? [{ id: post.id, path: post.path, kind: post.kind,
            date: post.date ?? null, name: postName, summary: postSummary, in_reply_to: post.inReplyTo }] : [post];
          output.result({ thread: { path: target.thread.path, name: target.name, summary: rung === "name" ? undefined : target.summary },
            posts, ...(rung === "full" ? { pinned: target.pinned } : {}), pin: target.pin, position: target.position, acknowledged: false },
            rung === "full" ? target.pinned : rung === "name" ? target.name : `${target.name}\n${postName} — ${postSummary}`);
          return 0;
        }
        if (flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        const thread = loadThread(resolveLocalThread(rest[0]));
        reportDateWarnings(thread, output);
        const rung = depth(flags, "summary");
        const newOnly = yes(flags, "new");
        const seen = newOnly ? readCursor(thread) : new Set<string>();
        const posts = thread.posts.filter((p) => !seen.has(p.id));
        const ack = yes(flags, "ack");
        if (ack && rung === "name") throw new Error("Cannot --ack at name depth: no posts were shown.");
        const pin = str(flags, "pin");
        const position = str(flags, "position");
        if (flags.pin === true || flags.position === true) throw new Error("--pin and --position require values.");
        if (!!pin !== !!position) throw new Error("Pinned open requires both --pin <authored SHA> and --position <_threads/...md>.");
        if (position && !position.startsWith(`_threads/${thread.slug}/`)) {
          throw new Error(`Pinned member ${position} belongs to another Thread; open its own local path instead.`);
        }
        const pinned = pin && position ? readPinnedThreadMember(threadBase(), pin, position) : undefined;
        if (pinned && parseThreadPost(pinned).status !== "valid" && !position?.endsWith("README.md")) throw new Error("Pinned post is invalid.");
        if (ack) acknowledge(thread, posts);
        const projected = rung === "name" ? [] : posts.map((p) => rung === "summary"
          ? { id: p.id, path: p.path, kind: p.kind, date: p.date ?? null, name: p.frontmatter.name ?? p.id,
            summary: p.frontmatter.summary ?? p.body.split("\n").find(Boolean) ?? "", in_reply_to: p.inReplyTo }
          : p);
        output.result({ thread: { path: thread.path, name: thread.name, summary: rung === "name" ? undefined : thread.summary,
          closed: thread.closed }, posts: projected,
          ...(pinned ? { pinned: rung === "full" ? pinned : undefined, pin, position } : {}), acknowledged: ack },
          pinned && rung === "full" ? pinned : localText(thread, posts, rung)); return 0;
      }
      if (sub === "post" || sub === "close") {
        if (rest.length !== 1 || HOSTED.test(rest[0])) throw new Error(`Usage: threads ${sub} <local-path> [--message <body>]`);
        for (const flag of ["map", "reply-to", "kind", "author", "name", "summary", "supersedes", "message"]) {
          if (flags[flag] === true) throw new Error(`--${flag} requires a value.`);
        }
        if (sub === "close" && flags.kind !== undefined && flags.kind !== "closure") throw new Error("threads close always appends a closure post; omit --kind.");
        selectionFlags(flags);
        const kind = sub === "close" ? "closure" : str(flags, "kind") ?? "post";
        if (!KINDS.has(kind)) throw new Error("--kind must be post, snapshot, reframe, correction or closure.");
        if (sub === "close" && (flags.member !== undefined || flags.checkout !== undefined)) throw new Error("Selected cross-Space close is not supported; use the local Space's close verb.");
        const map = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
        const selected = flags.member !== undefined
          ? selectPinnedThreadMember(map, str(flags, "member") ?? "") : undefined;
        if (!selected && flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        if (selected && flags.author !== undefined) throw new Error("Selected Thread posts use the caller's Agreement name; omit --author.");
        if (selected && kind === "closure") throw new Error("Selected cross-Space closure is not supported; use the local Space's close verb.");
        const parents = str(flags, "reply-to")?.split(",").map((id) => id.trim());
        if (parents?.some((id) => !id)) throw new Error("--reply-to must name non-empty post ids, separated by commas.");
        if (selected && !parents?.length) throw new Error("Selected post requires explicit --reply-to <post-id> at the authored pin.");
        const target = selected ? selectLocalThreadTarget(rest[0], selected.root, selected.member, str(flags, "checkout")) : undefined;
        const body = str(flags, "message") ?? await stdin();
        const { post, path } = appendPost(target?.thread.path ?? resolveLocalThread(rest[0]), { body, name: str(flags, "name"),
          summary: str(flags, "summary"), author: target ? selectedWriterName() : writerName(str(flags, "author")), replyTo: parents,
          kind: kind as ThreadKind, supersedes: str(flags, "supersedes"), map,
          verifyTarget: target?.verifyWrite });
        output.result({ id: post.id, path, kind: post.kind }, `Appended ${post.kind}: ${path}`); return 0;
      }
      if (sub === "render") {
        if (rest.length !== 1) throw new Error("Usage: threads render <local-path>");
        const thread = loadThread(resolveLocalThread(rest[0]));
        reportDateWarnings(thread, output);
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
