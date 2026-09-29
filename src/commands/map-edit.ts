import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseDocument, stringify, YAMLSeq } from "yaml";
import { parseMap, type MapMember } from "@ideaspaces/protocol";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const USAGE = "ideaspaces map create <path.map.md|README.md> --name <name> --summary <summary>\n       ideaspaces map add <map-note> <address> [--depth name|summary] [--name <name>] [--summary <summary>]\n       ideaspaces map add <map-note> --position <path> --depth <name|summary|surface|children|full> (--root <index> | --root-node-id <id> --sha <commit>)\n       ideaspaces map remove <map-note> <member-index|address> [--if-match <sha256>]";

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

function memberFrom(args: string[], flags: Record<string, string | boolean>, roots: unknown[]): { member: MapMember; root?: unknown } {
  const position = value(flags, "position");
  const address = args[0];
  if (position !== undefined) {
    if (address) throw new Error("Choose a position or an address, not both.");
    const depth = value(flags, "depth");
    const existingRoot = value(flags, "root");
    const id = value(flags, "root-node-id");
    const sha = value(flags, "sha");
    if (!depth || (!existingRoot && !(id && sha)) || (existingRoot && (id || sha))) {
      throw new Error("Position needs --depth and either --root <index> or --root-node-id <id> --sha <commit>.");
    }
    const root = existingRoot === undefined ? roots.length : Number(existingRoot);
    if (!Number.isInteger(root) || root < 0 || root > roots.length || (existingRoot !== undefined && root === roots.length)) {
      throw new Error(roots.length === 0
        ? "Map has no roots. Supply --root-node-id <id> --sha <commit> to add one."
        : `Root index ${existingRoot} is not in this Map (0..${roots.length - 1}).`);
    }
    const member = { root, position, depth, ...(value(flags, "name") ? { name: value(flags, "name") } : {}),
      ...(value(flags, "summary") ? { summary: value(flags, "summary") } : {}) } as MapMember;
    return { member, ...(id && sha ? { root: { root_node_id: id, sha } } : {}) };
  }
  if (!address || args.length !== 1 || flags.root !== undefined || flags["root-node-id"] !== undefined || flags.sha !== undefined) {
    throw new Error("Address needs exactly one <address>; position members use --position and --root.");
  }
  return { member: { address, ...(value(flags, "depth") ? { depth: value(flags, "depth") } : {}),
    ...(value(flags, "name") ? { name: value(flags, "name") } : {}),
    ...(value(flags, "summary") ? { summary: value(flags, "summary") } : {}) } as MapMember };
}

export const MAP_EDIT_USAGE = USAGE;
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
      if (verb === "add") {
        const { member, root } = memberFrom(members, flags, parsed.map.roots);
        const candidate = parseMap({ roots: [...parsed.map.roots, ...(root ? [root] : [])], members: [...parsed.map.members, member] });
        if (candidate.status !== "valid") throw new Error(`Invalid member: ${candidate.status === "invalid" ? candidate.issues.map((i) => `${i.path} (${i.code})`).join(", ") : "missing map"}`);
        if (root) {
          let roots = doc.getIn(["map", "roots"], true);
          if (!roots) { doc.setIn(["map", "roots"], []); roots = doc.getIn(["map", "roots"], true); }
          if (!(roots instanceof YAMLSeq)) throw new Error("Map roots must be a sequence.");
          roots.add(root);
        }
        index = seq.items.length;
        seq.add(member);
      } else {
        if (members.length !== 1) throw new Error("map remove needs one member index or address.");
        const requested = members[0];
        if (/^(0|[1-9]\d*)$/.test(requested)) {
          index = Number(requested);
        } else {
          const matches = parsed.map.members.flatMap((member, i) => "address" in member && member.address === requested ? [i] : []);
          if (matches.length > 1) throw new Error(`Address ${requested} matches multiple members (${matches.join(", ")}); remove by index.`);
          index = matches[0] ?? -1;
        }
        if (!Number.isSafeInteger(index) || index < 0 || index >= seq.items.length) throw new Error(`Member ${requested} was not found; run map ${file} --json to see indices.`);
        seq.items.splice(index, 1);
      }
      // Keep the source's line endings, including delimiters. YAML's Document
      // API preserves comments but may reflow a long scalar when it is edited.
      const newline = front[0].startsWith("---\r\n") ? "\r\n" : "\n";
      const next = `---${newline}${doc.toString().replace(/\n/g, newline)}---${original.slice(front[0].length)}`;
      // Refuse edits made by non-cooperating writers while this command worked.
      if (hash(await fs.readFile(file, "utf8")) !== hash(original)) throw new Error(`Map base moved while editing ${file}. Re-read and retry.`);
      await replace(file, next);
      return { index, sha: hash(next) };
    }, output.error);
    output.result({ path: file, member_index: changed.index, sha: changed.sha }, `${verb === "add" ? "Added" : "Removed"} member ${changed.index}: ${file}`);
    return 0;
  } catch (error) {
    output.error(`${errorMessage(error)}${(error as NodeJS.ErrnoException).code === "ENOENT" ? " (check the map path and its parent directory)" : ""}`);
    return 1;
  }
}
