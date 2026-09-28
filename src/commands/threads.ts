import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseFrontmatter, parseMap, parseThreadPost, type ThreadKind } from "@ideaspaces/protocol";
import { parse as parseYaml } from "yaml";
import { apiErrorDetail, fetchExchange, fetchInbox, fetchSpaceThreads, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import { exchangeText, hostedThreadsCommand } from "./inbox.js";
import { sanitizedGitEnvironment } from "../git.js";
import {
  acknowledge, appendPost, createThread, initWorktree, listLocal, loadThread,
  pushWorktree, readCursor, readPinnedThreadMember, resolveLocalThread, threadBase,
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
  return threads.filter((thread) => !newOnly || thread.posts.some((p) => !readCursor(thread).has(p.id)))
    .map((thread) => ({ source: "local" as const, id: thread.path, slug: thread.slug, name: thread.name,
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
function writerName(explicit?: string): string {
  if (explicit) return explicit;
  const agreement = resolve(process.cwd(), "_agent", "agreement.md");
  if (existsSync(agreement)) {
    const fm = parseFrontmatter(readFileSync(agreement, "utf8"));
    if (typeof fm?.agreement === "string" && fm.agreement.startsWith("agent:repo:") && typeof fm.name === "string") return fm.name.replace(/^Agreement\s*[—-]\s*/, "");
  }
  const result = spawnSync("git", ["config", "user.name"], { cwd: process.cwd(), encoding: "utf8", env: sanitizedGitEnvironment() });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  throw new Error("No writer identity. Pass --author <name> (or set git user.name / run from an agent Agreement).");
}
function loadLocalMap(input: string): unknown {
  const path = resolve(input);
  let value: unknown;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 128 * 1024) throw new Error("--map file must be a regular file no larger than 128 KiB.");
    const content = readFileSync(path, "utf8");
    const fm = parseFrontmatter(content);
    value = fm?.map ?? parseYaml(content);
  } else {
    value = parseYaml(input);
  }
  if (value && typeof value === "object" && "map" in value) value = (value as { map: unknown }).map;
  if (parseMap(value).status !== "valid") throw new Error("--map must supply valid roots and members with authored pins.");
  return value;
}

export const threadsCommand: CommandDef = {
  name: "threads",
  description: "List, read and write local or hosted Threads (local posts stay in Git)",
  usage: "ideaspaces threads <list|open|new|post|close|render|init|push|read|send|reply|expand> ...",
  examples: [
    "ideaspaces threads list [<dir>] [--new] [--space n_…]",
    "ideaspaces threads open <slug|path|x_id> [--depth name|summary|full] [--new] [--ack]",
    "ideaspaces threads new <slug> --about 'What we are deciding'",
    "ideaspaces threads post <slug|path> --message 'Decision' [--reply-to <id>] [--kind snapshot] [--map selection.json]",
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
          try { localThreads = listLocal(cwd); local = localRows(localThreads, newOnly); }
          catch (error) { if (rest.length) throw error; /* Hosted-only contexts have no Agreement. */ }
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
        const rows = [...local, ...hosted].map((row) => rung === "name"
          ? { source: row.source, id: row.id, name: row.name }
          : rung === "full" && row.source === "local"
            ? { ...row, posts: localThreads.find((thread) => thread.path === row.id)?.posts ?? [] }
            : row);
        const hint = !config && !rest.length ? "\nHosted Threads not checked (not logged in; run `ideaspaces login`)." : "";
        output.result({ threads: rows, hosted_checked: Boolean(config) }, (rows.length ? rows.map((r) => rung === "name"
          ? `${r.id}  ${r.name}` : rung === "full" && "posts" in r && Array.isArray(r.posts)
            ? localText(localThreads.find((thread) => thread.path === r.id)!, r.posts, "full")
            : rung === "full" && "text" in r && typeof r.text === "string"
              ? r.text
              : `${r.id}  ${r.name}\n  ${"summary" in r ? r.summary : ""} · ${r.source}`).join("\n\n") : "No local Threads here.") + hint);
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
          const parsed = parseMap(loadLocalMap(str(flags, "map") ?? ""));
          if (parsed.status !== "valid") throw new Error("Invalid authored Map.");
          const ordinal = Number(str(flags, "member"));
          if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("--member <zero-based ordinal> is required with --map.");
          const member = parsed.map.members[ordinal];
          if (!member || !("position" in member) || typeof member.position !== "string" || !("root" in member) || typeof member.root !== "number") throw new Error("Selected Map member is not a pinned local position.");
          const selectedRoot = parsed.map.roots[member.root];
          if (!selectedRoot?.sha) throw new Error("Selected Map root has no authored commit pin.");
          pin = selectedRoot.sha;
          position = member.position;
        }
        if (flags.pin === true || flags.position === true) throw new Error("--pin and --position require values.");
        if (!!pin !== !!position) throw new Error("Pinned open requires both --pin <authored SHA> and --position <_threads/...md>.");
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
        const map = str(flags, "map") ? loadLocalMap(str(flags, "map")!) : undefined;
        const { post, path } = appendPost(resolveLocalThread(rest[0]), { body, name: str(flags, "name"),
          summary: str(flags, "summary"), author: writerName(str(flags, "author")), replyTo: parents,
          kind: kind as ThreadKind, supersedes: str(flags, "supersedes"), map });
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
