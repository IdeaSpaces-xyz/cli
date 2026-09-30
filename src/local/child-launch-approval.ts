// Local, per-user child execution approval. This is deliberately separate from
// agent project declarations and from the per-agent extension approvals in #184.
// Only the CLI approve/revoke verb writes it through this module; agent run
// only verifies. This is NOT a human-presence boundary against another process
// with the same user's filesystem or PTY access. Release needs such an authority.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configDir } from "../auth/config-dir.js";
import { isContained } from "./contained-path.js";

const STORE = "child-launch-sets.json";
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_STORE = 256 * 1024;
const MAX_FILES = 100_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;

export interface ChildResourceSet {
  extensions: string[];
  skills: string[];
  packages: Array<{ root: string; name: string; version: string; digest: string }>;
}
interface ApprovalStore { version: 1; sets: Record<string, ChildResourceSet> }

export function validLaunchSetName(name: string): boolean { return NAME.test(name); }
export function launchSetStorePath(): string { return join(configDir(), STORE); }

function fail(message: string): never { throw new Error(`Child launch approval: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function checkDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022)) fail(`unsafe config directory: ${path}`);
}
function recordPath(): string {
  const dir = configDir();
  checkDirectory(dir);
  return join(dir, STORE);
}

function validateStore(value: unknown): ApprovalStore {
  if (!object(value) || value.version !== 1 || !object(value.sets) || Object.keys(value).some((k) => k !== "version" && k !== "sets")) fail("corrupt approval record; re-author it from a trusted terminal");
  const sets: Record<string, ChildResourceSet> = Object.create(null);
  for (const [name, candidate] of Object.entries(value.sets)) {
    if (!validLaunchSetName(name) || !object(candidate) || Object.keys(candidate).sort().join() !== "extensions,packages,skills") fail("corrupt approval record");
    const paths = (paths: unknown): paths is string[] => Array.isArray(paths) && paths.length <= 32 && paths.every((p) => typeof p === "string" && isAbsolute(p) && !p.includes("\0")) && new Set(paths).size === paths.length;
    if (!paths(candidate.extensions) || !candidate.extensions.length || !paths(candidate.skills) || !Array.isArray(candidate.packages) || candidate.packages.length > 32) fail("corrupt approval record");
    const packages = candidate.packages.map((pkg) => {
      if (!object(pkg) || Object.keys(pkg).sort().join() !== "digest,name,root,version" || typeof pkg.root !== "string" || !isAbsolute(pkg.root) || typeof pkg.name !== "string" || !pkg.name.trim() || typeof pkg.version !== "string" || !pkg.version.trim() || typeof pkg.digest !== "string" || !HEX.test(pkg.digest)) fail("corrupt approval record");
      return { root: pkg.root, name: pkg.name, version: pkg.version, digest: pkg.digest };
    });
    sets[name] = { extensions: candidate.extensions, skills: candidate.skills, packages };
  }
  return { version: 1, sets };
}

export function readLaunchSets(): ApprovalStore {
  const path = recordPath();
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sets: Object.create(null) };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail(`unsafe approval record: ${path}`);
  try { return validateStore(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (error instanceof Error && error.message.startsWith("Child launch approval:")) throw error; fail(`corrupt approval record: ${path}`); }
}

/** Atomic replacement under a lock; no concurrent editor may silently replace a review. */
export function changeLaunchSets(update: (store: ApprovalStore) => void): void {
  const path = recordPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700, recursive: true });
  checkDirectory(dir);
  const lock = `${path}.lock`;
  let handle: number;
  try { handle = openSync(lock, "wx", 0o600); }
  catch { return fail(`another approval writer holds ${lock}; check it before retrying`); }
  let temp: string | undefined;
  try {
    const store = readLaunchSets();
    update(store);
    const bytes = JSON.stringify(store, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > MAX_STORE) fail("approval record exceeds size limit");
    temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    // An external writer cannot replace a symlink during the approved write.
    try { if (lstatSync(path).isSymbolicLink()) fail("approval record changed during write"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(temp, path);
    temp = undefined;
  } finally {
    if (temp) rmSync(temp, { force: true });
    closeSync(handle);
    rmSync(lock, { force: true });
  }
}

function packageFor(path: string): { root: string; name: string; version: string } {
  let cursor = lstatSync(path).isDirectory() ? path : dirname(path);
  while (true) {
    const manifest = join(cursor, "package.json");
    if (existsSync(manifest)) {
      const stat = lstatSync(manifest);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail(`unsafe package.json: ${manifest}`);
      let value: unknown;
      try { value = JSON.parse(readFileSync(manifest, "utf8")); } catch { fail(`invalid package.json: ${manifest}`); }
      if (!object(value) || typeof value.name !== "string" || !value.name.trim() || typeof value.version !== "string" || !value.version.trim()) fail(`package name and version required: ${manifest}`);
      return { root: realpathSync(cursor), name: value.name, version: value.version };
    }
    const parent = dirname(cursor);
    if (parent === cursor) fail(`no versioned package.json contains ${path}`);
    cursor = parent;
  }
}

/** Digest all executable package bytes, including dependencies and skill dirs.
 * .git metadata alone is excluded: a commit/ref update without byte changes is not execution.
 * This deliberately fails rather than silently truncating an oversized package. */
function digestPackage(root: string): string {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (++files > MAX_FILES) fail(`package has more than ${MAX_FILES} entries: ${root}`);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isContained(root, target) || relative(root, target).split(sep).includes(".git")) fail(`package symlink escapes the reviewed content: ${path}`);
        hash.update(`link\0${rel}\0${readlinkSync(path)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`dir\0${rel}\0`);
        walk(path);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE || (bytes += stat.size) > MAX_BYTES) fail(`package exceeds content limit: ${root}`);
        hash.update(`file\0${rel}\0${stat.mode & 0o111}\0${stat.size}\0`);
        hash.update(readFileSync(path));
      } else fail(`non-regular package entry: ${path}`);
    }
  };
  walk(root);
  return hash.digest("hex");
}

function checkedPath(path: string, kind: "extension" | "skill"): string {
  if (!isAbsolute(path) || !existsSync(path)) fail(`${kind} path not found: ${path}`);
  const real = realpathSync(path);
  const stat = lstatSync(real);
  if (kind === "skill" ? !stat.isDirectory() : !stat.isDirectory() && !stat.isFile()) fail(`invalid ${kind} path: ${path}`);
  return real;
}

export function inspectLaunchSet(extensions: readonly string[], skills: readonly string[]): ChildResourceSet {
  if (extensions.length < 1 || extensions.length > 32 || skills.length > 32) fail("select 1–32 extensions and at most 32 skill directories");
  const selected = {
    extensions: [...new Set(extensions.map((p) => checkedPath(p, "extension")))].sort(),
    skills: [...new Set(skills.map((p) => checkedPath(p, "skill")))].sort(),
  };
  const packages = new Map<string, { root: string; name: string; version: string; digest: string }>();
  for (const path of [...selected.extensions, ...selected.skills]) {
    const pkg = packageFor(path);
    if (!isContained(pkg.root, path)) fail(`resource escapes package ${pkg.root}: ${path}`);
    if (!packages.has(pkg.root)) packages.set(pkg.root, { ...pkg, digest: digestPackage(pkg.root) });
  }
  return { ...selected, packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root)) };
}

function identical(left: ChildResourceSet, right: ChildResourceSet): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Named selection or exact legacy --ext/--skill match. Never writes approval. */
export function selectApprovedLaunch(name: string | undefined, extensions: readonly string[], skills: readonly string[]): { name: string; set: ChildResourceSet } {
  const store = readLaunchSets();
  let chosen: string;
  if (name !== undefined) {
    if (!validLaunchSetName(name)) fail("use a named --launch-set with letters, digits, _ or -");
    if (extensions.length || skills.length) fail("--launch-set cannot be combined with --ext or --skill");
    if (!store.sets[name]) fail(`unknown or revoked set '${name}'; approve it from a trusted terminal with agent launch-set approve`);
    chosen = name;
  } else {
    if (!extensions.length) fail("choose --launch-set <name> or explicitly approved --ext/--skill paths");
    const selected = { extensions: [...new Set(extensions)].sort(), skills: [...new Set(skills)].sort() };
    const match = Object.entries(store.sets).find(([, set]) => JSON.stringify({ extensions: set.extensions, skills: set.skills }) === JSON.stringify(selected));
    if (!match) fail("these --ext/--skill paths do not match any approved child set; approve a named set from a trusted terminal");
    chosen = match[0];
  }
  const stored = store.sets[chosen]!;
  const current = inspectLaunchSet(stored.extensions, stored.skills);
  if (!identical(stored, current)) fail(`set '${chosen}' changed (package bytes, version or skills); revoke and approve it again before launching`);
  return { name: chosen, set: current };
}
