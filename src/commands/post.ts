/**
 * `ideaspaces post <target>` — append one entry to anything that keeps time (protocol 0.33.0): a
 * local Thread by slug or path, any folder whose Agreement says `keeps_time: true`, or a hosted
 * Thread by its `x_…` id. `post --new <slug>` opens a Thread.
 *
 * The entry may set the folder's state: `--parent` (a post reference) moves a Thread, `--about`
 * says what it is about, `--closed true|false` closes or reopens, `--map` makes it the current
 * Map. A `reframe` carrying `--name`/`--summary` renames; one carrying only `--parent` moves and
 * leaves the name alone. A local entry is committed on its own, that one file, never pushed.
 * `threads post`, `new`, `close` and `attach` stay as they are; this is the one verb over them.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { isPostReference, parseThreadAttachment, type ThreadKind } from "@ideaspaces/protocol";
import { allowedFlags } from "../agent-tools/flags.js";
import { commitPaths, GitError } from "../git.js";
import { appendEntry, folderPosition } from "../local/entry-writer.js";
import { folderKeeping } from "../local/folder-state.js";
import { loadLocalThreadMap } from "../local/thread-map-member.js";
import {
  appendPost, commitPost, createThread, isHostedThreadTarget, KIND_HELP, NOT_IN_GIT_REPOSITORY, resolveLocalThread, validateThreadMomentMap,
  type PostCommit,
} from "../local/threads.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef } from "../types.js";
import { postVerb } from "./hosted-threads.js";
import { writerName } from "./threads.js";

type Flags = Record<string, string | boolean>;
const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? flags[key] : undefined);
const WRITER_KINDS = new Set(["post", "reframe", "correction", "mark", "snapshot", "closure"]);

const USAGE = "ideaspaces post <thread|folder|x_id> --message <text> [--reply-to <id>[,<id>]] [--kind post|reframe|correction|mark] [--parent <post:msg_…>] [--about <type>:<id>[,…]] [--closed true|false] [--name <title>] [--summary <text>] [--map <note>] [--mark <value>] [--supersedes <id>] [--tags <labels>] [--author <name>] [--no-check-links] [--no-commit]\n" +
  "       ideaspaces post --new <slug> --name <title> [--summary <text>] [--message <opening>] [--parent <post:msg_…>] [--about <type>:<id>[,…]] [--map <note>] [--author <name>] [--no-commit]\n" +
  "       ideaspaces post x_<id> --message <text> --reply-to <msg_id> [--name <title>] [--summary <text>] [--map <note>] [--tags <labels>] [--post-id <id>]";

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function commitLine(outcome: PostCommit, noCommit: boolean): string {
  return outcome.committed ? `\nCommitted ${outcome.commit.slice(0, 12)}: only this entry's file. Not pushed; push it for anyone else to read it.`
    : noCommit ? "\nState: local only. Written, not committed (--no-commit); commit and push it for anyone else to read it."
    : outcome.reason === NOT_IN_GIT_REPOSITORY ? "\nState: local only. This folder is not in a Git repository, so there is nothing to commit or push here; the file is on this disk only."
    : `\nState: local only. Written, not committed: ${outcome.reason}. The entry is on this disk; commit that file when you can.`;
}

function parseClosed(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error("--closed takes true or false: true closes the folder, false reopens it.");
}

export const postCommand: CommandDef = {
  name: "post",
  description: "Append an entry to a Thread, a folder that keeps time, or a hosted Thread; --new opens a Thread",
  usage: USAGE,
  help: "An entry is an immutable Markdown file with an id, a date and a kind, and it may set the folder's state (protocol 0.33.0): --parent (a post reference) moves a Thread; --about says what it is about, any typed links, an empty value clears; --closed true closes and --closed false reopens; --map makes the entry's Map the current one. A reframe that carries --name or --summary renames the Thread; one that carries only --parent moves it and leaves the name alone. --kind is one of " + KIND_HELP + ". The target is a Thread slug or path, any folder whose own _agent/agreement.md says keeps_time: true (files there without an id are Notes and are left alone; the entry answers nothing unless --reply-to says so), or a hosted x_ id (sent, never retried; --post-id for an exact resend). A local entry is committed on its own, that one file, never pushed, unless --no-commit. During the compatibility window a move also writes the Agreement's attached_to and a close also writes kind: closure, for readers before 0.33.0.",
  examples: [
    "ideaspaces post 2026-11-16-protocol-revision --message 'PR 1 is open.' --reply-to msg_4eb28874 --author Integrator",
    "ideaspaces post 2026-11-16-protocol-revision --kind reframe --parent post:msg_c0946031 --message 'It belongs under the Spine now.'  # a move; the name stays",
    "ideaspaces post 2026-11-16-protocol-revision --kind reframe --name 'A wider title' --summary 'One line' --message 'Why'  # a rename",
    "ideaspaces post 2026-11-16-protocol-revision --closed true --message 'Done when held; closing.'",
    "ideaspaces post memory --message 'A squash merge makes a new SHA.' --name 'Pin the protocol by commit' --author Integrator  # a folder whose Agreement says keeps_time: true",
    "ideaspaces post memory --kind correction --supersedes msg_1b7f2056 --name 'Pin by tag' --message 'The tag resolves in the lock.'",
    "ideaspaces post --new 2026-11-17-a-topic --name 'A topic' --parent post:msg_c0946031 --about note:@home//notes/why.md --message 'Where this starts.'",
    "ideaspaces post x_0123456789abcdef01234567 --reply-to msg_parent --message 'Answer'  # hosted, through the service",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const newSlug = str(flags, "new");
    if (flags.new !== undefined && !newSlug) { output.error("--new needs a slug: ideaspaces post --new <slug> --name <title>."); return 1; }
    const target = args[0]?.trim();
    if (!newSlug && (args.length !== 1 || !target)) { output.error(`Usage: ${USAGE}`); return 1; }
    if (newSlug && args.length) { output.error("--new opens a Thread by its slug; it takes no target."); return 1; }
    for (const flag of ["message", "reply-to", "kind", "parent", "about", "closed", "name", "summary", "map", "mark", "supersedes", "tags", "author", "post-id"]) {
      if (flags[flag] === true) { output.error(`--${flag} requires a value.`); return 1; }
    }

    // A hosted Thread: the service's writer, with the hosted subset of flags.
    if (target && isHostedThreadTarget(target)) {
      const hosted = allowedFlags("post", "hosted");
      const unknown = Object.keys(flags).find((flag) => !hosted.has(flag));
      if (unknown) { output.error(`--${unknown} is not supported for a hosted Thread; post x_<id> takes ${[...hosted].map((f) => `--${f}`).join(", ")}. A hosted post's kind comes from its verb; its parent and state are kept by the service.`); return 1; }
      return postVerb(output, global.json, target, flags);
    }

    try {
      const kind = str(flags, "kind") ?? "post";
      if (!WRITER_KINDS.has(kind)) throw new Error(`--kind ${JSON.stringify(kind)} is not a kind: use ${KIND_HELP}. A label goes in --tags.`);
      const closed = parseClosed(flags.closed);
      const parentRef = str(flags, "parent");
      if (parentRef !== undefined) {
        const attachment = parseThreadAttachment(parentRef);
        if (!attachment || !isPostReference(attachment)) throw new Error(`--parent must name a post (post:msg_…, msg_… or _threads/<thread>/<post>.md), not ${parentRef}. A link that is not a post goes in --about. Nothing written.`);
      }
      const about = flags.about === undefined ? undefined : str(flags, "about") === "" ? [] : str(flags, "about")!.split(",").map((link) => link.trim()).filter(Boolean);
      const tags = str(flags, "tags")?.split(",").map((tag) => tag.trim());
      const parents = str(flags, "reply-to")?.split(",").map((id) => id.trim());
      if (parents?.some((id) => !id)) throw new Error("--reply-to must name non-empty entry ids, separated by commas.");
      const map = str(flags, "map") ? loadLocalThreadMap(str(flags, "map")!) : undefined;
      const author = writerName(str(flags, "author"));
      const noCommit = flags["no-commit"] === true;
      if (kind === "snapshot") output.log("snapshot is a legacy kind: written as a post carrying the Map, which readers take as the folder's current Map.");

      if (newSlug) {
        const name = str(flags, "name");
        if (!name) throw new Error("--new needs --name <title>: the Thread's name, which its opening post carries.");
        if (closed !== undefined || kind !== "post" || flags.mark !== undefined || flags.supersedes !== undefined || parents) throw new Error("--new writes an opening post; omit --kind, --closed, --mark, --supersedes and --reply-to.");
        const summary = str(flags, "summary") ?? name;
        // The opening's body is the title unless --message says more; it never waits on stdin, as threads new does not.
        const body = str(flags, "message") ?? name;
        // During the window the opening carries parent or about beside attached_to, which readers before 0.33.0 read.
        const attachedTo = parentRef ?? about?.[0];
        if (map !== undefined) validateThreadMomentMap(map); // before createThread touches the folder
        const thread = createThread(newSlug, name, process.cwd(), attachedTo);
        if (summary !== name) writeFileSync(join(thread.path, "README.md"), `---\n${stringify({ name, summary })}---\n\n# ${name}\n`);
        let opening: ReturnType<typeof appendPost>;
        try {
          opening = appendPost(thread.path, { body: body.trim() || name, name, summary, author, attachedTo, ...(parentRef ? { parent: parentRef } : {}), ...(about !== undefined ? { about } : {}), map, tags });
        } catch (error) {
          throw new Error(`Thread created at ${thread.path}, but its opening post was not written: ${error instanceof Error ? error.message : String(error)}. Use ideaspaces post ${newSlug} --message <opening> to complete it; do not rerun --new.`);
        }
        let outcome: PostCommit = { committed: false, reason: "--no-commit" };
        if (!noCommit) {
          try {
            const files = [join(thread.path, "README.md"), join(thread.path, "_agent", "agreement.md"), opening.path];
            outcome = { committed: true, commit: commitPaths(`Thread ${thread.slug}: opened\n\n${name}`, files, thread.path) };
          } catch (error) {
            outcome = { committed: false, reason: error instanceof GitError || error instanceof Error ? error.message : String(error) };
          }
        }
        output.result({ path: thread.path, slug: thread.slug, thread_id: opening.post.id, opening_post_id: opening.post.id, date: opening.post.date, name, summary,
          ...(parentRef ? { parent: parentRef } : {}), ...(about !== undefined ? { about } : {}), ...(attachedTo ? { attached_to: attachedTo } : {}),
          committed: outcome.committed, ...(outcome.committed ? { commit: outcome.commit } : { reason: outcome.reason }) },
          `Opened Thread ${thread.slug}: ${thread.path}${commitLine(outcome, noCommit).replace("only this entry's file", "the README, the Agreement and the opening post")}`);
        return 0;
      }

      // A local target: a Thread by slug or path, or a folder that keeps time by its Agreement.
      const asPath = resolve(target!);
      const dir = existsSync(asPath) && statSync(asPath).isDirectory() ? asPath : resolveLocalThread(target!);
      const keeping = folderKeeping(dir);
      if (!keeping) throw new Error(`${target} keeps no time: it is not a Thread, and its Agreement does not say keeps_time: true. Write a Note there with ideaspaces write, or turn time on in its _agent/agreement.md.`);
      const body = str(flags, "message") ?? await stdin();
      const common = {
        body, name: str(flags, "name"), summary: str(flags, "summary"), author, replyTo: parents, kind: kind as ThreadKind, mark: str(flags, "mark"),
        supersedes: str(flags, "supersedes"), map, tags, ...(parentRef !== undefined ? { parent: parentRef } : {}), ...(about !== undefined ? { about } : {}),
        ...(closed !== undefined ? { closed } : {}), rejectEscapedNewlines: typeof flags.message === "string",
      };
      let written: { id: string; kind: string; inReplyTo: string[]; path: string; label: string; name?: string; warnings: string[]; mark?: string };
      if (keeping === "placement") {
        // A close keeps the legacy kind beside the field, as threads close does, for readers before 0.33.0.
        const legacyClose = closed === true && kind === "post";
        const result = appendPost(dir, { ...common, kind: legacyClose ? "closure" : common.kind, checkLinks: flags["no-check-links"] !== true,
          onDefaultReplyTo: (id) => output.log(`Replying to opening post ${id}. Pass --reply-to <id> to answer a specific post, or --reply-to latest for newest.`) });
        written = { id: result.post.id, kind: result.post.kind, inReplyTo: result.post.inReplyTo, path: result.path, label: `Thread ${basename(dir)}`, name: result.post.frontmatter.name, warnings: result.warnings, mark: result.post.mark };
      } else {
        const result = appendEntry(dir, common);
        written = { id: result.post.id, kind: result.post.kind, inReplyTo: result.post.inReplyTo, path: result.path, label: result.position, name: result.post.frontmatter.name, warnings: [], mark: result.post.mark };
      }
      for (const warning of written.warnings) output.log(`Link warning: ${warning}`);
      const outcome: PostCommit = noCommit ? { committed: false, reason: "--no-commit" }
        : commitPost(written.path, `${written.label}: ${written.kind} ${written.id}${written.name ? `\n\n${written.name}` : ""}`);
      output.result({ id: written.id, path: written.path, kind: written.kind, ...(written.mark ? { mark: written.mark } : {}), in_reply_to: written.inReplyTo,
        folder: { position: keeping === "placement" ? `_threads/${basename(dir)}` : folderPosition(dir), keeping },
        ...(parentRef !== undefined ? { parent: parentRef } : {}), ...(about !== undefined ? { about } : {}), ...(closed !== undefined ? { closed } : {}),
        committed: outcome.committed, ...(outcome.committed ? { commit: outcome.commit } : { reason: outcome.reason }), ...(written.warnings.length ? { warnings: written.warnings } : {}) },
        `Appended ${written.kind}: ${written.path}${commitLine(outcome, noCommit)}`);
      return 0;
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  },
};
