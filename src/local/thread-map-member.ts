import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter, parseMap, type MapPositionMember, type MapRoot } from "@ideaspaces/protocol";
import { parse as parseYaml } from "yaml";

/** The authored Map input and ordinal used by both `threads open` and `agent run`. */
export function loadLocalThreadMap(input: string): unknown {
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

export function selectPinnedThreadMember(value: unknown, ordinal: string): { root: MapRoot; member: MapPositionMember } {
  const parsed = parseMap(value);
  if (parsed.status !== "valid") throw new Error("Invalid authored Map.");
  const index = Number(ordinal);
  if (!/^(0|[1-9][0-9]*)$/.test(ordinal) || !Number.isSafeInteger(index)) throw new Error("--member <zero-based ordinal> is required with --map.");
  const member = parsed.map.members[index];
  if (!member || !("position" in member) || typeof member.position !== "string" || typeof member.root !== "number") throw new Error("Selected Map member is not a pinned local position.");
  const root = parsed.map.roots[member.root];
  if (!root?.sha) throw new Error("Selected Map root has no authored commit pin.");
  return { root, member: member as MapPositionMember };
}
