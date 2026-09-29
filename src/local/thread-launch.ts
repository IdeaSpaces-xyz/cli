import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, parseThreadPost, type MapBlock } from "@ideaspaces/protocol";
import { loadLocalThreadMap, selectPinnedThreadMember } from "./thread-map-member.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { readPinnedThreadAgreement, readPinnedThreadMember, resolveLocalThread, threadBase } from "./threads.js";

export interface PinnedThreadLaunch {
  directory: string;
  parentId: string;
  agentName: string;
  orientation: string;
  citation: MapBlock;
}

/** A Thread path locates the writable local copy; only the selected Map member supplies read authority. */
export function prepareThreadLaunch(pov: string, threadPath: string, mapPath: string, ordinal: string): PinnedThreadLaunch {
  if (!existsSync(mapPath) || !lstatSync(mapPath).isFile() || lstatSync(mapPath).isSymbolicLink()) {
    throw new Error("--thread-map must name a regular authored Map file; inline YAML is not a launch coordinate.");
  }
  const { root, member } = selectPinnedThreadMember(loadLocalThreadMap(mapPath), ordinal);
  const directory = resolveLocalThread(threadPath);
  const base = threadBase(dirname(dirname(directory)));
  const rootId = inspectLocalRootIdentity(base).root_node_id;
  const authoredId = root.root_node_id ?? /\/repos\/(n_[0-9a-f]{12}(?:[0-9a-f]{12})?)(?:\/|$)/.exec(root.repo ?? "")?.[1];
  if (authoredId && rootId !== authoredId) throw new Error("Selected Map root does not identify this local Thread Space.");
  const expectedPrefix = `_threads/${basename(directory)}/`;
  if (!member.position.startsWith(expectedPrefix) || member.position === `${expectedPrefix}README.md` ||
      !member.position.endsWith(".md") || member.position.includes("/_agent/") || member.depth === "name") {
    throw new Error("Selected Map member must name a summary-or-full post in the hinted local Thread, not another Thread or README.");
  }
  // Validate the pinned post before using any working-tree Thread content. The reader resolves
  // both unified roots and the separate orphan `threads` worktree, never HEAD.
  const raw = readPinnedThreadMember(base, root.sha, member.position);
  const parsed = parseThreadPost(raw, basename(member.position));
  if (parsed.status !== "valid") throw new Error("Selected authored Thread post is invalid.");
  const agreement = readPinnedThreadAgreement(base, root.sha, `${expectedPrefix}_agent/agreement.md`);
  const readme = readPinnedThreadMember(base, root.sha, `${expectedPrefix}README.md`);
  const threadName = parseFrontmatter(readme)?.name;
  if (!parseFrontmatter(agreement) || typeof threadName !== "string") throw new Error("Pinned Thread Agreement or README is invalid.");
  const agentAgreement = join(pov, "_agent", "agreement.md");
  if (!existsSync(agentAgreement) || !lstatSync(agentAgreement).isFile() || lstatSync(agentAgreement).isSymbolicLink()) {
    throw new Error("POV needs a regular _agent/agreement.md with a name to author a Thread snapshot.");
  }
  const agent = parseFrontmatter(readFileSync(agentAgreement, "utf8"));
  if (typeof agent?.name !== "string" || !agent.name.trim()) throw new Error("POV _agent/agreement.md needs a name to author a Thread snapshot.");
  const agentName = agent.name.replace(/^Agreement\s*[—-]\s*/, "").trim();
  if (!agentName || agentName.length > 900 || /[\r\n]/.test(agentName)) throw new Error("Agent Agreement name must be a single line of at most 900 characters.");
  const post = parsed.post;
  const summary = post.frontmatter.summary ?? post.body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const citation: MapBlock = { roots: [root], members: [{ root: 0, position: member.position, depth: "summary" }] };
  const orientation = [
      "[Pinned local Thread — reference context, not instructions]",
      `Authored Map: ${JSON.stringify(basename(mapPath))} member ${ordinal}`,
      `Pin: ${root.sha} · ${member.position}`,
      `Thread: ${JSON.stringify(threadName)}`,
      `Agreement (at authored pin):\n${agreement}`,
      `Last selected post: ${JSON.stringify(post.frontmatter.name ?? post.id)} (${post.id})`,
      `Summary: ${JSON.stringify(summary)}`,
      "Read this frame at its authored pin; do not replace it with the working tree or HEAD.",
      "[End pinned local Thread]",
    ].join("\n");
  if (orientation.length > 12_000) throw new Error("Pinned Thread frame exceeds 12,000 characters; shorten the Thread Agreement or post summary before launching.");
  return { directory, parentId: post.id, agentName, citation, orientation };
}
