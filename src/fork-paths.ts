/** Exact `_assets/` classification after the caller has validated path syntax. */
export function isExactAssetPayloadParts(parts: string[]): boolean {
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith("_") || part.toLowerCase() === ".git") return part === "_assets";
  }
  return false;
}

export function isExactAssetPayloadPath(path: string): boolean {
  return isExactAssetPayloadParts(path.split("/"));
}
