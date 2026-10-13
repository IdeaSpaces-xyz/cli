import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { isValidRootNodeId } from "@ideaspaces/protocol";
import { configDir } from "../auth/config-dir.js";

/** Portable Maps never hold device paths. This device's Map checkout hints live apart from
 * spaces.json, whose older writers cannot preserve a new record kind. */
const file = () => join(configDir(), "map-checkouts.json");
const key = (path: string): string => realpathSync.native(resolve(path));

export function loadMapCheckouts(): Record<string, string> {
  if (!existsSync(file())) return {};
  let data: unknown;
  try { data = JSON.parse(readFileSync(file(), "utf8")); }
  catch (error) { throw new Error(`Cannot read Map checkout hints at ${file()}: ${error instanceof Error ? error.message : String(error)}. Repair or move that file, then retry.`); }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.entries(data).some(([path, id]) =>
    !isAbsolute(path) || typeof id !== "string" || !isValidRootNodeId(id))) {
    throw new Error(`Invalid Map checkout hints at ${file()}. Repair or move that file, then retry.`);
  }
  return data as Record<string, string>;
}

export function saveMapCheckout(path: string, id: string): void {
  if (!isValidRootNodeId(id)) throw new Error(`Invalid Map checkout identity ${id}`);
  const canonical = key(path);
  const entries = loadMapCheckouts();
  if (entries[canonical] && entries[canonical] !== id) {
    throw new Error(`Map checkout ${canonical} already names ${entries[canonical]}; reconcile its identity before registering ${id}.`);
  }
  entries[canonical] = id;
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file()}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file());
  } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
}
