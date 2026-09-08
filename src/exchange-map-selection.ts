import {
  buildMap,
  type MapAddressMember,
  type MapBlock,
  type MapMember,
  type MapPositionMember,
} from "@ideaspaces/protocol";

const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;
const SHA1 = /^[0-9a-f]{40}$/;
const HOSTNAME_ADDRESS = /^hostname:(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]+)?$/;

export interface ExchangeMapSelection {
  kind: "exchange-map-selection";
  target_node_id: string;
  map: MapBlock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function stringField(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/**
 * Parse only the first direct-exchange transport profile. Rebuilding every
 * object from its public fields makes machine-local bindings impossible to
 * smuggle into the send body even though the protocol parser preserves
 * extension fields for forward compatibility.
 */
export function parseExchangeMapSelection(value: unknown): ExchangeMapSelection {
  if (!isRecord(value)) throw new Error("Map selection must be a JSON object");
  exactKeys(value, ["kind", "target_node_id", "map"], "Map selection");
  if (value.kind !== "exchange-map-selection") {
    throw new Error("Map selection kind must be exchange-map-selection");
  }
  if (typeof value.target_node_id !== "string" || !NODE_ID.test(value.target_node_id)) {
    throw new Error("Map selection target_node_id is invalid");
  }
  if (!isRecord(value.map)) throw new Error("Map selection map must be an object");
  exactKeys(value.map, ["roots", "members"], "Map selection map");
  if (!Array.isArray(value.map.roots) || !Array.isArray(value.map.members)) {
    throw new Error("Map selection roots and members must be arrays");
  }

  const roots = value.map.roots.map((raw, ordinal) => {
    if (!isRecord(raw)) throw new Error(`Map root ${ordinal} must be an object`);
    exactKeys(raw, ["space", "root_node_id", "sha"], `Map root ${ordinal}`);
    const rootNodeId = stringField(raw.root_node_id, `Map root ${ordinal} root_node_id`);
    const sha = stringField(raw.sha, `Map root ${ordinal} sha`);
    if (!rootNodeId || !NODE_ID.test(rootNodeId)) {
      throw new Error(`Map root ${ordinal} root_node_id is required and invalid`);
    }
    if (!sha || !SHA1.test(sha)) throw new Error(`Map root ${ordinal} sha must be a full SHA-1`);
    return {
      ...(raw.space === undefined ? {} : { space: stringField(raw.space, `Map root ${ordinal} space`)! }),
      root_node_id: rootNodeId,
      sha,
    };
  });
  const members = value.map.members.map((raw, ordinal): MapMember => {
    if (!isRecord(raw)) throw new Error(`Map member ${ordinal} must be an object`);
    const address = "address" in raw;
    exactKeys(
      raw,
      address
        ? ["address", "name", "summary", "depth", "disclosure"]
        : ["space", "position", "name", "summary", "depth", "disclosure"],
      `Map member ${ordinal}`,
    );
    if (!isRecord(raw.disclosure)) throw new Error(`Map member ${ordinal} disclosure must be an object`);
    exactKeys(raw.disclosure, ["name", "summary"], `Map member ${ordinal} disclosure`);
    const disclosure = {
      ...(raw.disclosure.name === undefined
        ? {}
        : { name: stringField(raw.disclosure.name, `Map member ${ordinal} disclosure.name`)! }),
      ...(raw.disclosure.summary === undefined
        ? {}
        : { summary: stringField(raw.disclosure.summary, `Map member ${ordinal} disclosure.summary`)! }),
    };
    const annotations = {
      ...(raw.name === undefined ? {} : { name: stringField(raw.name, `Map member ${ordinal} name`)! }),
      ...(raw.summary === undefined
        ? {}
        : { summary: stringField(raw.summary, `Map member ${ordinal} summary`)! }),
    };
    if (address) {
      const addressValue = stringField(raw.address, `Map member ${ordinal} address`) ?? "";
      if (!HOSTNAME_ADDRESS.test(addressValue)) {
        throw new Error(`Map member ${ordinal} address must be a canonical hostname:`);
      }
      return {
        address: addressValue,
        ...(raw.depth === undefined ? {} : { depth: stringField(raw.depth, `Map member ${ordinal} depth`) as "name" | "summary" }),
        ...annotations,
        disclosure,
      };
    }
    return {
      space: raw.space as number,
      position: stringField(raw.position, `Map member ${ordinal} position`) ?? "",
      depth: stringField(raw.depth, `Map member ${ordinal} depth`) as MapPositionMember["depth"],
      ...annotations,
      disclosure,
    };
  });

  const built = buildMap({ roots, members });
  if (built.status === "invalid") {
    const detail = built.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
    throw new Error(`Map selection is invalid: ${detail}`);
  }
  return { kind: "exchange-map-selection", target_node_id: value.target_node_id, map: built.map };
}

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

export function memberReference(member: MapMember, roots: MapBlock["roots"]): string {
  if (isAddressMember(member)) return member.address;
  const root = roots[member.space];
  const coordinate = root?.root_node_id ?? root?.space ?? `root:${member.space}`;
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

export function isPositionMember(member: MapMember): member is MapPositionMember {
  return "position" in member;
}

export function isAddressMember(member: MapMember): member is MapAddressMember {
  return "address" in member;
}
