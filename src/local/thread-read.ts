import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  inspectMarkdown,
  parseFrontmatter,
  stripFrontmatter,
  summarizeMarkdown,
  type ContentLookTarget,
  type MapDepth,
  type ThreadPost,
} from "@ideaspaces/protocol";
import type { BranchInfo, ChildThreadInfo, LocalThread, ThreadParentInfo } from "./threads.js";

export type ThreadDepth = "name" | "summary" | "children" | "surface" | "full";

const SURFACE_BODY_BYTES = 800;

export function clip(text: string, bytes: number, marker = "… [shortened; read the exact file or use --post <id>]"): string {
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

export function threadSection(markdown: string, heading: string): string | undefined {
  const match = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(markdown);
  return match?.[1]?.trim() || undefined;
}

export function threadFrame(thread: LocalThread): { current_frame?: string; goal?: string; done_when?: string } {
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

export function findThreadPost(posts: ThreadPost[], target: string): ThreadPost | undefined {
  const norm = target.replace(/\\/g, "/");
  const file = basename(norm);
  const bareId = file.replace(/\.md$/, "");

  const matches = posts.filter((p) => {
    return (
      p.id === target ||
      p.id === bareId ||
      p.path === target ||
      p.path === file ||
      basename(p.path) === file ||
      p.path.endsWith(`-${bareId}.md`) ||
      p.path === `${bareId}.md`
    );
  });

  if (matches.length > 1) {
    // Exact id or path match breaks ambiguity
    const exact = matches.find((p) => p.id === target || p.path === target || p.path === file);
    if (exact) return exact;
    throw new Error(`Ambiguous post reference "${target}" matches ${matches.length} posts in this Thread.`);
  }

  return matches[0];
}

export function buildFrameMarkdownTarget(path: string, position: string, content: string, depth: MapDepth): ContentLookTarget {
  const fm = parseFrontmatter(content);
  const name = (typeof fm?.name === "string" && fm.name.trim()) || basename(path, ".md");
  const summary = (typeof fm?.summary === "string" && fm.summary.trim()) || summarizeMarkdown(content);
  const disclosure = { name, ...(summary && depth !== "name" ? { summary } : {}) };
  const target: ContentLookTarget = {
    placement: "history",
    path,
    position,
    kind: "markdown",
    depth,
    revision: "",
    name,
    member: { position, depth, disclosure },
  };
  if (depth !== "name") {
    target.summary = summary;
  }
  if (depth === "surface" || depth === "full") {
    target.surface = stripFrontmatter(content);
  } else if (depth === "children") {
    const outline = inspectMarkdown(content, { mode: "outline" });
    target.children = outline.mode === "outline"
      ? outline.headings.map((h) => ({ ...h, kind: "section" as const, name: h.text }))
      : [];
  }
  const represented = {
    kind: target.kind,
    name: target.name,
    ...(target.summary !== undefined ? { summary: target.summary } : {}),
    ...(target.surface !== undefined ? { surface: target.surface } : {}),
    ...(target.children !== undefined ? { children: target.children } : {}),
  };
  target.revision = `sha256:${createHash("sha256").update(JSON.stringify(represented)).digest("hex")}`;
  return target;
}

export function localText(
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
    const parentLine = options?.parent ? `Attached to: ${clip(options.parent.attached_to, 400)}` : undefined;
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

  const context = `${rung === "full" ? thread.name : clip(thread.name, 200)} (${thread.path})\n${rung === "full" ? thread.summary : clip(thread.summary, 400)}\n${thread.closed ? "closed" : "open"} · ${thread.posts.length} posts`;

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
              `${p.id} · ${p.kind} · ${p.date ?? "undated"} · ${clip(p.frontmatter.name ?? p.id, 200)} · in_reply_to ${p.inReplyTo.join(", ") || "—"} · ${p.frontmatter.author ?? "unknown author"}\n  ${clip(p.frontmatter.summary ?? "(no summary)", 400)}`,
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
        (c) => `  ${c.slug}  ${clip(c.name, 200)}\n    attached to ${c.attached_to_post_id ?? c.attached_to} · ${c.count} posts · ${c.closed ? "closed" : "open"}${c.latest_activity_at ? ` · latest: ${c.latest_activity_at}` : ""}\n    summary: ${clip(c.summary || "(no summary)", 200)}`,
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
        `\n${p.id} · ${p.frontmatter.author ?? "unknown author"} · ${p.kind}${p.inReplyTo.length ? ` ↳ ${p.inReplyTo.join(", ")}` : ""}${p.frontmatter.tags?.length ? ` · tags: ${p.frontmatter.tags.join(", ")}` : ""}\n${p.frontmatter.name ?? ""}\n${p.body}`,
    ),
  ].join("\n");
}
