import type { MapBlock, MapMember } from "@ideaspaces/protocol";

function quoted(value: unknown): string {
  return JSON.stringify(value);
}

function annotation(member: MapMember): string | null {
  const fields = [
    typeof member.name === "string" ? `name=${quoted(member.name)}` : null,
    typeof member.summary === "string" ? `summary=${quoted(member.summary)}` : null,
  ].filter((value): value is string => value !== null);
  return fields.length ? `curated ${fields.join(" ")}` : null;
}

function disclosure(member: MapMember): string {
  const observed = member.disclosure ?? {};
  return [
    typeof observed.name === "string" ? `name=${quoted(observed.name)}` : null,
    typeof observed.summary === "string" ? `summary=${quoted(observed.summary)}` : null,
  ].filter((value): value is string => value !== null).join(" ");
}

function memberReference(member: MapMember, roots: MapBlock["roots"]): string {
  if ("address" in member) {
    return member.revision ? `${member.address}@${member.revision}` : member.address;
  }
  const root = roots[member.root];
  const coordinate = root?.root_node_id ?? root?.repo ?? `root:${member.root}`;
  return `${coordinate}@${root?.sha ?? "?"}:${member.position}`;
}

export function formatPortableMap(map: MapBlock, indent = ""): string[] {
  const lines = [`${indent}Context Map (${map.members.length} ordered members):`];
  for (const [ordinal, member] of map.members.entries()) {
    lines.push(
      `${indent}  [${ordinal}] ${memberReference(member, map.roots)} · ceiling=${member.depth ?? "summary"}`,
      `${indent}      observed ${disclosure(member) || "(none)"}`,
    );
    const curated = annotation(member);
    if (curated) lines.push(`${indent}      ${curated}`);
  }
  return lines;
}

