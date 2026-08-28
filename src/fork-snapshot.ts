import type { SpaceCopySnapshotFile, SpaceCopySnapshotResult } from "./auth/api.js";
import { isExactAssetPayloadParts } from "./fork-paths.js";
import { normalizeSnapshot } from "./fork-update.js";

const MAX_MARKDOWN_FILES = 1_000;
const MAX_MARKDOWN_BYTES = 20_000_000;
const MAX_ASSET_FILES = 1_000;
const MAX_ASSET_BYTES = 20_000_000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

export interface PreparedForkSnapshot {
  sourceHead: string;
  markdown: Record<string, string>;
  assets: Array<{ path: string; content: Buffer }>;
  markdownFileCount: number;
  assetFileCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

/** Validate one server-authored portable path before it reaches the host filesystem. */
function validatePath(value: unknown, role: "markdown" | "asset"): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    /[\0-\x1f\x7f]/.test(value) ||
    Buffer.byteLength(value, "utf-8") > 4_096
  ) {
    throw new Error(`Unsafe ${role} path in source snapshot: ${String(value)}`);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        WINDOWS_FORBIDDEN.test(part) ||
        WINDOWS_RESERVED_NAME.test(part) ||
        Buffer.byteLength(part, "utf-8") > 255,
    )
  ) {
    throw new Error(`Unsafe ${role} path in source snapshot: ${value}`);
  }
  const assetPayload = isExactAssetPayloadParts(parts);
  if (role === "markdown" && (!value.endsWith(".md") || assetPayload)) {
    throw new Error(`Invalid Markdown path in source snapshot: ${value}`);
  }
  if (role === "asset" && !assetPayload) {
    throw new Error(`Supporting payload is outside exact _assets/: ${value}`);
  }
  return value;
}

function collisionKey(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
}

function assertNoPathCollisions(paths: string[]): void {
  const keyed = paths.map((path) => ({ path, key: collisionKey(path) }));
  const seen = new Map<string, string>();
  for (const { path, key } of keyed) {
    const prior = seen.get(key);
    if (prior) throw new Error(`Snapshot paths collide on a portable filesystem: ${prior}, ${path}`);
    seen.set(key, path);
  }
  keyed.sort((left, right) => left.key.localeCompare(right.key));
  for (let index = 0; index < keyed.length - 1; index++) {
    const parent = keyed[index];
    const child = keyed[index + 1];
    if (child.key.startsWith(`${parent.key}/`)) {
      throw new Error(`Snapshot file/directory paths collide: ${parent.path}, ${child.path}`);
    }
  }
}

function decodeBase64(value: unknown, path: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Invalid base64 supporting payload: ${path}`);
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error(`Non-canonical base64 supporting payload: ${path}`);
  }
  return content;
}

/** Validate the complete bounded envelope before any destination path is touched. */
export function prepareForkSnapshot(
  value: unknown,
  markdownBaseline: Record<string, string> = {},
): PreparedForkSnapshot {
  if (!isRecord(value)) throw new Error("The source returned an invalid snapshot envelope");
  const snapshot = value as unknown as SpaceCopySnapshotResult;
  if (
    typeof snapshot.source_head !== "string" ||
    !/^[0-9a-f]{40}$/.test(snapshot.source_head) ||
    !boundedInteger(snapshot.markdown_file_count, MAX_MARKDOWN_FILES) ||
    !boundedInteger(snapshot.markdown_bytes, MAX_MARKDOWN_BYTES) ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length !== snapshot.markdown_file_count
  ) {
    throw new Error("The source returned an invalid snapshot envelope");
  }

  const files: SpaceCopySnapshotFile[] = [];
  let receivedMarkdownBytes = 0;
  for (const item of snapshot.files as unknown[]) {
    if (!isRecord(item) || typeof item.content !== "string") {
      throw new Error("The source returned an invalid snapshot file");
    }
    const path = validatePath(item.path, "markdown");
    receivedMarkdownBytes += Buffer.byteLength(item.content, "utf-8");
    if (receivedMarkdownBytes > MAX_MARKDOWN_BYTES) {
      throw new Error("The source snapshot exceeds the local Markdown limit");
    }
    files.push({ path, content: item.content });
  }

  const rawAssets = snapshot.assets ?? [];
  const assetFileCount = snapshot.asset_file_count ?? 0;
  const assetBytes = snapshot.asset_bytes ?? 0;
  if (
    !boundedInteger(assetFileCount, MAX_ASSET_FILES) ||
    !boundedInteger(assetBytes, MAX_ASSET_BYTES) ||
    !Array.isArray(rawAssets) ||
    rawAssets.length !== assetFileCount
  ) {
    throw new Error("The source returned an invalid supporting-payload envelope");
  }

  const assets: PreparedForkSnapshot["assets"] = [];
  let receivedAssetBytes = 0;
  for (const item of rawAssets as unknown[]) {
    if (!isRecord(item)) throw new Error("The source returned an invalid supporting payload");
    const path = validatePath(item.path, "asset");
    const content = decodeBase64(item.content_base64, path);
    receivedAssetBytes += content.length;
    if (receivedAssetBytes > MAX_ASSET_BYTES) {
      throw new Error("The source snapshot exceeds the local supporting-payload limit");
    }
    assets.push({ path, content });
  }
  if (receivedAssetBytes !== assetBytes) {
    throw new Error("The source supporting-payload byte count does not match its envelope");
  }

  assertNoPathCollisions([...files.map((file) => file.path), ...assets.map((asset) => asset.path)]);
  const markdown = normalizeSnapshot(files, markdownBaseline);
  return {
    sourceHead: snapshot.source_head,
    markdown,
    assets,
    markdownFileCount: files.length,
    assetFileCount: assets.length,
  };
}
