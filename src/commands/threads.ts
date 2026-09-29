import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter, parseThreadPost, type ThreadKind } from "@ideaspaces/protocol";
import { loadLocalThreadMap, selectPinnedThreadMember } from "../local/thread-map-member.js";
import { selectLocalThreadTarget } from "../local/cross-thread-target.js";
import { apiErrorDetail, fetchExchange, fetchInbox, fetchSpaceThreads, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
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
function localRows(threads: LocalThread[], newOnly: boolean) {
  return threads.filter((thread) => {
    if (!newOnly) return true;
    const seen = readCursor(thread);
    return thread.posts.some((post) => !seen.has(post.id));
  }).map((thread) => ({ source: "local" as const, id: thread.path, slug: thread.slug, name: thread.name,
    summary: thread.summary, count: thread.posts.length, closed: thread.closed }));
}
function localText(thread: LocalThread, posts: LocalThread["posts"], rung: string): string {
  if (rung === "name") return `${thread.slug}  ${thread.name}`;
  const header = `${thread.name} (${thread.path})\n${thread.summary}\n${thread.closed ? "closed" : "open"} · ${thread.posts.length} posts`;
  return [header, ...posts.map((p) => rung === "summary"
    ? `\n${p.frontmatter.name ?? p.id} — ${p.frontmatter.summary ?? p.body.split("\n").find(Boolean) ?? ""}`
    : `\n${p.id} · ${p.frontmatter.author ?? "unknown author"} · ${p.kind}${p.inReplyTo.length ? ` ↳ ${p.inReplyTo.join(", ")}` : ""}\n${p.frontmatter.name ?? ""}\n${p.body}`),
  ].join("\n");
}
function writerName(explicit?: string, requireAgent = false): string {
  if (explicit) return explicit;
  let at = resolve(process.cwd());
  while (true) {
    const agreement = join(at, "_agent", "agreement.md");
    if (existsSync(agreement)) {
      if (requireAgent && (lstatSync(agreement).isSymbolicLink() || !lstatSync(agreement).isFile())) throw new Error("Caller Agent Agreement must be a regular file.");
      const fm = parseFrontmatter(readFileSync(agreement, "utf8"));
      if (typeof fm?.agreement === "string" && fm.agreement.startsWith("agent:repo:") && typeof fm.name === "string") {
        return fm.name.replace(/^Agreement\s*[—-]\s*/, "");
      }
    }
    if (dirname(at) === at) break;
    at = dirname(at);
  }
  if (requireAgent) throw new Error("Selected Thread posts require the caller's Agent Agreement name; no git-author fallback.");
  const result = spawnSync("git", ["config", "user.name"], { cwd: process.cwd(), encoding: "utf8", env: sanitizedGitEnvironment() });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  throw new Error("No writer identity. Pass --author <name> (or set git user.name / run from an agent Agreement).");
}
export const threadsCommand: CommandDef = {
  name: "threads",
  description: "List, read and write local or hosted Threads (local posts stay in Git)",
  usage: "ideaspaces threads <list|open|new|post|close|render|init|push|read|send|reply|expand> ...",
  examples: [
    "ideaspaces threads list [<dir>] [--new] [--space n_…]",
    "ideaspaces threads open <slug|path|x_id> [--depth name|summary|full] [--new] [--ack]",
    "ideaspaces threads new <slug> --about 'What we are deciding'",
    "ideaspaces threads post <slug> --message 'Decision' --map home.map.md --member 0 --reply-to msg_id [--checkout /absolute/space/root]",
    "ideaspaces threads open <slug> --map home.map.md --member 0 [--checkout /absolute/space/root]  # selected pin only",
    "ideaspaces threads open <slug|path> --pin <40-hex-sha> --position _threads/<slug>/<post>.md",
    "ideaspaces threads close <slug|path> --message 'Closing rationale'",
    "ideaspaces threads render <slug|path>  # derived timeline; README stays curated",
    "ideaspaces threads init  # isolated orphan threads worktree at _threads/",
    "ideaspaces threads push --remote <team-remote>  # never origin/GitHub",
    "ideaspaces threads read x_<id> --new --ack  # hosted",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    try {
      if (sub === "read" || sub === "send" || sub === "reply" || sub === "expand") {
        if (sub === "read" && rest.length === 1 && !HOSTED.test(rest[0])) {
          output.error("For local Threads use `threads open <path>`; hosted `read` requires an x_ id."); return 1;
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
            local = localRows(localThreads, newOnly);
          } catch (error) {
            // Outside a Space, hosted listing still works. A malformed Thread or
            // cursor inside a Space is not an empty list — fail visibly.
            if (rest.length || !(error instanceof NoAgreementError)) throw error;
          }
        }
        const config = loadConfig();
        if (space && !config) throw new Error("Not logged in. Run `ideaspaces login` to list hosted Space Threads.");
        let hosted: Array<{ source: "hosted"; id: string; name: string; summary: string; count?: number; messages?: unknown[]; text?: string }> = [];
        if (config) {
          try {
            if (space) {
              const result = await fetchSpaceThreads(config, space);
              hosted = result.threads.map((t) => ({ source: "hosted", id: t.exchange_id, name: t.name, summary: t.summary }));
            } else if (!rest.length) {
              const result = await fetchInbox(config);
              hosted = result.items.filter((t) => t.kind === "inquiry")
                .filter((t) => !newOnly || t.cursor !== null && t.latest_position > t.cursor)
                .map((t) => ({ source: "hosted", id: t.exchange_id, name: t.latest_message.name, summary: t.latest_message.summary, count: t.message_count }));
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
          if (rung === "name") return { source: row.source, id: row.id, name: row.name };
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
        output.result({ path: thread.path, slug: thread.slug }, `Created local Thread: ${thread.path}`); return 0;
      }
      if (sub === "open") {
        if (rest.length !== 1) throw new Error("Usage: threads open <path|x_id> [--depth name|summary|full] [--new] [--ack]");
        if (HOSTED.test(rest[0])) return hostedThreadsCommand.run(["read", rest[0]], flags, global);
        if (flags.member !== undefined && flags.map === undefined || flags.checkout !== undefined && flags.map === undefined) throw new Error("--member and --checkout require --map.");
        if (flags.checkout === true) throw new Error("--checkout requires an absolute Space root path.");
        if (flags.map !== undefined && flags.member !== undefined) {
          if (flags.pin !== undefined || flags.position !== undefined) throw new Error("Use either --map with --member or --pin with --position, not both.");
          if (flags.new !== undefined || flags.ack !== undefined) throw new Error("Selected pinned reads cannot use live --new or --ack.");
          const { root, member } = selectPinnedThreadMember(loadLocalThreadMap(str(flags, "map") ?? ""), str(flags, "member") ?? "");
          const target = selectLocalThreadTarget(rest[0], root, member, str(flags, "checkout"));
          const rung = depth(flags, "summary");
          const parsed = parseThreadPost(target.pinned);
          if (parsed.status !== "valid") throw new Error("Selected pinned post is invalid.");
          const post = parsed.post;
          const posts = rung === "name" ? [] : rung === "summary" ? [{ id: post.id, path: post.path, kind: post.kind,
            name: post.frontmatter.name ?? post.id, summary: post.frontmatter.summary ?? post.body.split("\n").find(Boolean) ?? "", in_reply_to: post.inReplyTo }] : [post];
          const pinnedReadme = readPinnedThreadMember(target.checkout, target.pin, `_threads/${target.thread.slug}/README.md`);
          const frontmatter = parseFrontmatter(pinnedReadme);
          const name = typeof frontmatter?.name === "string" ? frontmatter.name : target.thread.slug;
          const summary = typeof frontmatter?.summary === "string" ? frontmatter.summary : "";
          output.result({ thread: { path: target.thread.path, name, summary: rung === "name" ? undefined : summary },
            posts, ...(rung === "full" ? { pinned: target.pinned } : {}), pin: target.pin, position: target.position, acknowledged: false },
            rung === "full" ? target.pinned : rung === "name" ? name : `${name}\n${post.frontmatter.name ?? post.id} — ${post.frontmatter.summary ?? post.body.split("\n").find(Boolean) ?? ""}`);
          return 0;
        }
        if (flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        const thread = loadThread(resolveLocalThread(rest[0]));
        const rung = depth(flags, "summary");
        const newOnly = yes(flags, "new");
        const seen = newOnly ? readCursor(thread) : new Set<string>();
        const posts = thread.posts.filter((p) => !seen.has(p.id));
        const ack = yes(flags, "ack");
        if (ack && rung === "name") throw new Error("Cannot --ack at name depth: no posts were shown.");
        let pin = str(flags, "pin");
        let position = str(flags, "position");
        if (flags.map !== undefined) {
          if (pin || position) throw new Error("Use either --map with --member or --pin with --position, not both.");
          const selected = selectPinnedThreadMember(loadLocalThreadMap(str(flags, "map") ?? ""), str(flags, "member") ?? "");
          pin = selected.root.sha;
          position = selected.member.position;
        }
        if (flags.pin === true || flags.position === true) throw new Error("--pin and --position require values.");
        if (!!pin !== !!position) throw new Error("Pinned open requires both --pin <authored SHA> and --position <_threads/...md>.");
        if (position && !position.startsWith(`_threads/${thread.slug}/`)) {
          throw new Error(`Pinned member ${position} belongs to another Thread; open its own local path instead.`);
        }
        const pinned = pin && position ? readPinnedThreadMember(threadBase(), pin, position) : undefined;
        if (pinned && parseThreadPost(pinned).status !== "valid" && !position?.endsWith("README.md")) throw new Error("Pinned post is invalid.");
        if (ack) acknowledge(thread, posts);
        const projected = rung === "name" ? [] : posts.map((p) => rung === "summary"
          ? { id: p.id, path: p.path, kind: p.kind, name: p.frontmatter.name ?? p.id,
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
        const kind = sub === "close" ? "closure" : str(flags, "kind") ?? "post";
        if (!KINDS.has(kind)) throw new Error("--kind must be post, snapshot, reframe, correction or closure.");
        const body = str(flags, "message") ?? await stdin();
        const parents = str(flags, "reply-to")?.split(",").map((id) => id.trim());
        if (flags.member !== undefined && flags.map === undefined || flags.checkout !== undefined && flags.map === undefined) throw new Error("--member and --checkout require --map.");
        if (flags.checkout === true) throw new Error("--checkout requires an absolute Space root path.");
        if (sub === "close" && (flags.member !== undefined || flags.checkout !== undefined)) throw new Error("Selected cross-Space close is not supported; use the local Space's close verb.");
        const map = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
        const selected = flags.member !== undefined
          ? selectPinnedThreadMember(map, str(flags, "member") ?? "") : undefined;
        if (!selected && flags.checkout !== undefined) throw new Error("--checkout requires --map and --member.");
        if (selected && flags.author !== undefined) throw new Error("Selected Thread posts use the caller's Agreement name; omit --author.");
        const target = selected ? selectLocalThreadTarget(rest[0], selected.root, selected.member, str(flags, "checkout")) : undefined;
        const { post, path } = appendPost(target?.thread.path ?? resolveLocalThread(rest[0]), { body, name: str(flags, "name"),
          summary: str(flags, "summary"), author: writerName(target ? undefined : str(flags, "author"), Boolean(target)), replyTo: parents,
          kind: kind as ThreadKind, supersedes: str(flags, "supersedes"), map,
          verifyTarget: target?.verifyWrite });
        output.result({ id: post.id, path, kind: post.kind }, `Appended ${post.kind}: ${path}`); return 0;
      }
      if (sub === "render") {
        if (rest.length !== 1) throw new Error("Usage: threads render <local-path>");
        const thread = loadThread(resolveLocalThread(rest[0]));
        const timeline = thread.posts.map((post) => ({ id: post.id, name: post.frontmatter.name ?? post.id, kind: post.kind,
          in_reply_to: post.inReplyTo, path: post.path }));
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
