import { createHash, randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseDocument, stringify, YAMLSeq } from "yaml";
import { parseCanonicalRepoUrl, parseMap, parseMapPositionAddress, resolveMapPositionAddress, type MapMember, type MapRoot } from "@ideaspaces/protocol";
import { findSpaceFor } from "../auth/spaces.js";
import { loadMapCheckouts, saveMapCheckout } from "../local/map-checkouts.js";
import { repoRoot } from "../git.js";
import { checkoutRootNodeId } from "../local/space-map.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const USAGE = "ideaspaces map create <path.map.md|README.md> --name <name> --summary <summary>\n       ideaspaces map add <map-note> <address> [--depth name|summary] [--name <name>] [--summary <summary>]\n       ideaspaces map add <map-note> --position <path> [--depth <name|summary|surface|children|full>] (--root <index> | --root-node-id <id> [--sha <commit>] | --checkout <repo> [--sha <commit>])\n       ideaspaces map remove <map-note> <member-index> --if-match <file_sha>  # map <map-note> --json\n       ideaspaces map remove <map-note> <address|@root//position> [--if-match <file_sha>]\n       ideaspaces map remove <map-note> --root-node-id <id> --position <path>\n       ideaspaces map remove <map-note> --root-node-id <id>  # remove an empty root explicitly";

function value(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function validFile(path: string): boolean { return basename(path) === "README.md" || basename(path).endsWith(".map.md"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// An exclusive directory lock serializes cooperating CLI processes. A timeout is a
// refusal, never permission to steal a possibly live lock. Atomic rename keeps
// readers from observing half a frontmatter write.
async function locked<T>(file: string, action: () => Promise<T>, warn: (message: string) => void): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 4000;
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const age = await fs.stat(lock).then((stat) => `${Math.round((Date.now() - stat.mtimeMs) / 1000)}s old`, () => "age unknown");
        throw new Error(`Map is locked: ${lock} (${age}). Retry after the writer finishes. If the writer crashed, confirm no writer is running, then remove the empty lock directory with rmdir.`);
      }
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  let result: T;
  try {
    result = await action();
  } catch (error) {
    // A cleanup failure must not hide the original edit refusal.
    await fs.rmdir(lock).catch(() => {});
    throw error;
  }
  // The write has already landed. A failed cleanup is a warning, not a failed
  // add: an agent retrying after a false failure would duplicate the member.
  try { await fs.rmdir(lock); }
  catch (error) { warn(`Map edit succeeded, but could not release ${lock}: ${errorMessage(error)}. Confirm no writer is running before removing the lock.`); }
  return result;
}

async function replace(file: string, content: string): Promise<void> {
  const temp = resolve(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    const mode = (await fs.stat(file)).mode & 0o777;
    await fs.writeFile(temp, content, { flag: "wx", mode });
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

function rootIdentity(root: MapRoot): string | undefined {
  if (root.root_node_id) return root.root_node_id;
  const parsed = root.repo ? parseCanonicalRepoUrl(root.repo) : null;
  return parsed?.status === "valid" ? parsed.rootNodeId : undefined;
}

function memberFrom(args: string[], flags: Record<string, string | boolean>, roots: MapRoot[]): { member: MapMember; root?: MapRoot; checkout?: { path: string; id: string } } {
  const position = value(flags, "position");
  const address = args[0];
  if (position !== undefined) {
    if (address) throw new Error("Choose a position or an address, not both.");
    const depth = value(flags, "depth");
    const existingRoot = value(flags, "root");
    const requestedId = value(flags, "root-node-id");
    const sha = value(flags, "sha");
    const checkout = value(flags, "checkout");
    if (existingRoot && (requestedId || sha || checkout)) {
      throw new Error("Choose --root <index> or --checkout <repo> / --root-node-id <id>, not both.");
    }
    let local: { path: string; id: string } | undefined;
    if (checkout) {
      let path: string;
      try { path = realpathSync.native(repoRoot(checkout)); }
      catch { throw new Error(`--checkout ${checkout} must be a local Git checkout with a declared root identity.`); }
      const id = checkoutRootNodeId(path);
      if (!id) throw new Error(`Checkout ${path} has no valid repository root identity; declare a root_node_id in its Agreement or Foundation first.`);
      if (requestedId && requestedId !== id) throw new Error(`--root-node-id ${requestedId} does not match checkout ${path} (${id}).`);
      local = { path, id };
    }
    const id = requestedId ?? local?.id;
    if ((!existingRoot && !id) || (sha && !id)) {
      throw new Error("Position needs --root <index>, --root-node-id <id>, or --checkout <repo> (optional --sha <commit>); --depth is optional on a Space Map.");
    }
    let root = existingRoot === undefined ? roots.length : Number(existingRoot);
    if (!Number.isInteger(root) || root < 0 || root > roots.length || (existingRoot !== undefined && root === roots.length)) {
      throw new Error(roots.length === 0
        ? "Map has no roots. Supply --root-node-id <id> or --checkout <repo> to add one."
        : `Root index ${existingRoot} is not in this Map (0..${roots.length - 1}).`);
    }
    if (id) {
      const matches = roots.flatMap((entry, index) => rootIdentity(entry) === id ? [index] : []);
      if (matches.length > 1) throw new Error(`Root ${id} occurs more than once; reconcile this Map before adding another member.`);
      if (matches.length === 1) {
        root = matches[0];
        if (roots[root].sha !== sha) throw new Error(`Root ${id} is ${roots[root].sha ? `pinned to ${roots[root].sha}` : "unpinned"}, but this add requested ${sha ?? "no pin"}. Select its existing index with --root or use a matching --sha.`);
      }
    }
    const member = { root, position, ...(depth ? { depth } : {}), ...(value(flags, "name") ? { name: value(flags, "name") } : {}),
      ...(value(flags, "summary") ? { summary: value(flags, "summary") } : {}) } as MapMember;
    return { member, ...(id && root === roots.length ? { root: { root_node_id: id, ...(sha ? { sha } : {}) } } : {}), ...(local ? { checkout: local } : {}) };
  }
  if (!address || args.length !== 1 || flags.root !== undefined || flags["root-node-id"] !== undefined || flags.sha !== undefined || flags.checkout !== undefined) {
    throw new Error("Address needs exactly one <address>; position members use --position and --root.");
  }
  return { member: { address, ...(value(flags, "depth") ? { depth: value(flags, "depth") } : {}),
    ...(value(flags, "name") ? { name: value(flags, "name") } : {}),
    ...(value(flags, "summary") ? { summary: value(flags, "summary") } : {}) } as MapMember };
}

export const MAP_EDIT_USAGE = USAGE;

export async function appendAddressMemberToMapFile(
  rawPath: string,
  address: string,
  depth: string = "summary",
): Promise<{ path: string; sha: string; index: number }> {
  if (!validFile(rawPath)) {
    throw new Error(`Invalid map file "${rawPath}". Space map files must be named README.md or *.map.md.`);
  }
  const requested = resolve(rawPath);
  const file = await fs.realpath(requested);
  return locked(file, async () => {
    const original = await fs.readFile(file, "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(original);
    if (!front) throw new Error(`No valid YAML frontmatter in ${file}.`);
    const doc = parseDocument(front[1], { uniqueKeys: true });
    if (doc.errors.length) throw new Error(`Invalid YAML in ${file}: ${doc.errors[0].message}`);
    const parsed = parseMap((doc.toJS() as Record<string, unknown> | null)?.map);
    if (parsed.status !== "valid") {
      throw new Error(`Invalid or missing Map in ${file}: ${parsed.status === "invalid" ? parsed.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "no map block"}`);
    }
    let seq = doc.getIn(["map", "members"], true);
    if (!seq) { doc.setIn(["map", "members"], []); seq = doc.getIn(["map", "members"], true); }
    if (!(seq instanceof YAMLSeq)) throw new Error("Map members must be a sequence.");
    const member = { address, depth };
    const candidate = parseMap({ roots: parsed.map.roots, members: [...parsed.map.members, member] });
    if (candidate.status !== "valid") {
      throw new Error(`Invalid member: ${candidate.status === "invalid" ? candidate.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "missing map"}`);
    }
    const index = seq.items.length;
    seq.add(member);
    const newline = front[0].startsWith("---\r\n") ? "\r\n" : "\n";
    const next = `---${newline}${doc.toString().replace(/\n/g, newline)}---${original.slice(front[0].length)}`;
    if (hash(await fs.readFile(file, "utf8")) !== hash(original)) throw new Error(`Map base moved while editing ${file}. Re-read and retry.`);
    await replace(file, next);
    return { path: file, sha: hash(next), index };
  }, () => {});
}
export async function runMapEdit(args: string[], flags: Record<string, string | boolean>, global: Parameters<CommandDef["run"]>[2]): Promise<number> {
  const output = createOutput(global);
  const [verb, raw, ...members] = args;
  if (!raw || !["create", "add", "remove"].includes(verb) || !validFile(raw)) {
    output.error(`Usage: ${USAGE}`);
    return 1;
  }
  const requested = resolve(raw);
  try {
    if (flags["if-match"] !== undefined && !value(flags, "if-match")) throw new Error("--if-match needs the Map's sha256 from the previous result.");
    if (verb === "create") {
      const name = value(flags, "name");
      const summary = value(flags, "summary");
      if (!name || !summary || members.length) throw new Error("map create needs --name and --summary and no member.");
      // wx is the create CAS: an existing file is never replaced.
      const content = `---\n${stringify({ name, summary, map: { roots: [], members: [] } })}---\n\n# ${name}\n`;
      await fs.writeFile(requested, content, { flag: "wx" });
      output.result({ path: requested, sha: hash(content) }, `Created Space Map: ${requested}`);
      return 0;
    }
    // Resolve aliases before locking: two paths to the same existing file must
    // serialize on the same lock, not write two competing snapshots.
    const file = await fs.realpath(requested);
    const changed = await locked(file, async () => {
      const original = await fs.readFile(file, "utf8");
      const match = value(flags, "if-match");
      if (match && match !== hash(original)) throw new Error(`Map base moved: expected ${match}, current ${hash(original)}. Re-read ${file} and retry.`);
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(original);
      if (!front) throw new Error(`No valid YAML frontmatter in ${file}.`);
      const doc = parseDocument(front[1], { uniqueKeys: true });
      if (doc.errors.length) throw new Error(`Invalid YAML in ${file}: ${doc.errors[0].message}`);
      const parsed = parseMap((doc.toJS() as Record<string, unknown> | null)?.map);
      if (parsed.status !== "valid") throw new Error(`Invalid or missing Map in ${file}: ${parsed.status === "invalid" ? parsed.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "no map block"}`);
      let seq = doc.getIn(["map", "members"], true);
      if (!seq) { doc.setIn(["map", "members"], []); seq = doc.getIn(["map", "members"], true); }
      if (!(seq instanceof YAMLSeq)) throw new Error("Map members must be a sequence.");
      let index: number;
      let registerCheckout: { path: string; id: string } | undefined;
      let removedRoot = false;
      let already: "already_present" | "already_absent" | undefined;
      if (verb === "add") {
        const { member, root, checkout } = memberFrom(members, flags, parsed.map.roots);
        const candidate = parseMap({ roots: [...parsed.map.roots, ...(root ? [root] : [])], members: [...parsed.map.members, member] });
        if (candidate.status !== "valid") throw new Error(`Invalid member: ${candidate.status === "invalid" ? candidate.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "missing map"}`);
        if (checkout) {
          const existing = findSpaceFor(checkout.path);
          if (existing && existing.root_node_id !== checkout.id) {
            throw new Error(`Local checkout record for ${checkout.path} disagrees with root ${checkout.id}; repair the record before editing the Map.`);
          }
          const prior = loadMapCheckouts()[checkout.path];
          if (prior && prior !== checkout.id) throw new Error(`Map checkout ${checkout.path} is registered as ${prior}, not ${checkout.id}.`);
          if (!existing && !prior) registerCheckout = checkout;
        }
        if (root) {
          let roots = doc.getIn(["map", "roots"], true);
          if (!roots) { doc.setIn(["map", "roots"], []); roots = doc.getIn(["map", "roots"], true); }
          if (!(roots instanceof YAMLSeq)) throw new Error("Map roots must be a sequence.");
          roots.add(root);
        }
        const existing = parsed.map.members.findIndex((entry) =>
          "address" in member
            ? "address" in entry && entry.address === member.address
            : "root" in entry && entry.root === member.root && entry.position === member.position,
        );
        index = existing < 0 ? seq.items.length : existing;
        if (existing >= 0) {
          const previous = parsed.map.members[existing];
          const fields = ["depth", "name", "summary", "attached_to"] as const;
          if (fields.some((key) => previous[key] !== member[key])) {
            throw new Error(`Member ${existing} already points here with different annotations. Edit the Map explicitly or remove it before adding a replacement.`);
          }
          already = "already_present";
        } else seq.add(member);
      } else {
        const byPosition = value(flags, "position");
        const id = value(flags, "root-node-id");
        if (byPosition && id && members.length === 0) members.push(`@${id}//${byPosition === "." ? "" : byPosition}`);
        if (id && !byPosition && members.length === 0 && flags.root === undefined && flags.checkout === undefined && flags.sha === undefined) {
          const matches = parsed.map.roots.flatMap((root, i) => rootIdentity(root) === id ? [i] : []);
          if (matches.length !== 1) throw new Error(`Root ${id} is ${matches.length ? "ambiguous" : "not in this Map"}; choose one valid identity.`);
          index = matches[0];
          if (parsed.map.members.some((entry) => "root" in entry && entry.root === index)) {
            throw new Error(`Root ${id} still has members. Remove those pointers first; roots are never removed implicitly.`);
          }
          const roots = doc.getIn(["map", "roots"], true);
          if (!(roots instanceof YAMLSeq)) throw new Error("Map roots must be a sequence.");
          roots.items.splice(index, 1);
          for (const entry of seq.items) {
            if (entry && typeof entry === "object" && "get" in entry && "set" in entry) {
              const node = entry as { get(key: string): unknown; set(key: string, value: number): void };
              const old = node.get("root");
              if (typeof old === "number" && old > index) node.set("root", old - 1);
            }
          }
          removedRoot = true;
        } else {
        if (members.length !== 1 || (byPosition && !id) || (id && !byPosition) || flags.root !== undefined || flags.checkout !== undefined || flags.sha !== undefined) {
          throw new Error("map remove needs one address, or --root-node-id <id> --position <path> (index requires --if-match).");
        }
        const requested = members[0];
        if (/^(0|[1-9]\d*)$/.test(requested)) {
          if (!match) throw new Error(`Removing by index requires --if-match <file_sha> from map ${file} --json; an index can name a different member after another edit. Or remove by address.`);
          index = Number(requested);
        } else {
          const address = parseMapPositionAddress(requested);
          if (address.status === "valid") {
            const resolved = resolveMapPositionAddress(parsed.map, address.address);
            if (resolved.status === "invalid" || (resolved.status === "unresolved" && resolved.code !== "root_not_in_map")) {
              throw new Error(`Cannot remove ${requested}: ${resolved.code}. Use a known root identity or index plus --if-match.`);
            }
            if (resolved.status === "unresolved" && address.address.root.kind !== "identity") {
              throw new Error(`Cannot remove ${requested}: root is not in this Map. Check the root name or identity.`);
            }
            const matches = resolved.status === "resolved"
              ? parsed.map.members.flatMap((entry, i) => "root" in entry && entry.root === resolved.rootIndex && entry.position === resolved.position ? [i] : [])
              : [];
            if (matches.length > 1) throw new Error(`Position ${requested} matches multiple members (${matches.join(", ")}); remove by index with --if-match.`);
            index = matches[0] ?? -1;
          } else {
            if (requested.startsWith("@") || requested.startsWith("//")) throw new Error(`Invalid position address ${requested}: ${address.code}. Use @<root-node-id>//<position>.`);
            const matches = parsed.map.members.flatMap((entry, i) => "address" in entry && entry.address === requested ? [i] : []);
            if (matches.length > 1) throw new Error(`Address ${requested} matches multiple members (${matches.join(", ")}); remove by index with --if-match.`);
            index = matches[0] ?? -1;
          }
        }
        if (!Number.isSafeInteger(index) || index < 0 || index >= seq.items.length) {
          if (/^(0|[1-9]\d*)$/.test(requested)) throw new Error(`Member ${requested} was not found; run map ${file} --json to see indices.`);
          already = "already_absent";
        } else {
          seq.items.splice(index, 1);
          // Roots are the Space, not a cache of members. Removing its last member
          // must not silently remove the root or change the identity of later indices.
        }
        }
      }
      if (already) {
        // A repeat --checkout also repairs a previous successful Map edit whose
        // device-local hint could not be saved. It never rewrites the Map.
        if (already === "already_present" && registerCheckout) {
          try { saveMapCheckout(registerCheckout.path, registerCheckout.id); }
          catch (error) {
            output.error(`Map member is present but checkout registration failed: ${errorMessage(error)}. Retry map add --checkout after fixing the registry.`);
            return { index, sha: hash(original), status: "already_unregistered" };
          }
        }
        return { index: already === "already_absent" ? null : index, sha: hash(original), status: already };
      }
      const edited = parseMap((doc.toJS() as Record<string, unknown>).map);
      if (edited.status !== "valid") throw new Error(`Map edit would be invalid: ${edited.status === "invalid" ? edited.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "missing map"}`);
      // Keep the source's line endings, including delimiters. YAML's Document
      // API preserves comments but may reflow a long scalar when it is edited.
      const newline = front[0].startsWith("---\r\n") ? "\r\n" : "\n";
      const next = `---${newline}${doc.toString().replace(/\n/g, newline)}---${original.slice(front[0].length)}`;
      // Refuse edits made by non-cooperating writers while this command worked.
      if (hash(await fs.readFile(file, "utf8")) !== hash(original)) throw new Error(`Map base moved while editing ${file}. Re-read and retry.`);
      await replace(file, next);
      // Never register a checkout on a refused/stale/locked Map edit.
      if (registerCheckout) {
        try { saveMapCheckout(registerCheckout.path, registerCheckout.id); }
        catch (error) {
          output.error(`Map edit succeeded but checkout registration failed: ${errorMessage(error)}. Retry the same map add --checkout after fixing the registry; it will register without rewriting the Map.`);
          return { index, sha: hash(next), status: "added_unregistered" };
        }
      }
      return { index, sha: hash(next), status: removedRoot ? "root_removed" : verb === "add" ? "added" : "removed" };
    }, output.error);
    output.result({ path: file, member_index: changed.index, sha: changed.sha, status: changed.status }, `${changed.status === "already_absent" ? "Already absent" : changed.status === "already_present" ? "Already present" : changed.status === "root_removed" ? "Removed root" : changed.status === "added_unregistered" ? "Added member (checkout not registered)" : changed.status === "already_unregistered" ? "Already present (checkout not registered)" : verb === "add" ? "Added member" : "Removed member"}${changed.index === null ? "" : ` ${changed.index}`}: ${file}`);
    return changed.status === "added_unregistered" || changed.status === "already_unregistered" ? 1 : 0;
  } catch (error) {
    output.error(`${errorMessage(error)}${(error as NodeJS.ErrnoException).code === "ENOENT" ? " (check the map path and its parent directory)" : ""}`);
    return 1;
  }
}
