// Hold the CLI's call inventory against the server's OpenAPI document.
//
//   node scripts/check-api-parity.mjs <openapi.json>
//
// Exit 1 when the CLI calls an operation the document does not serve, or one it
// marks `deprecated`. The document is an input — a CI artifact or a local
// export — never a checked-in copy: this repository is public and the server's
// route table is not. Path parameters compare by position, not by name: the
// CLI says `{repoId}` where the server says `{repo_id}`, and neither side is
// wrong. See api-calls.mjs for how the inventory is produced.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY } from "./api-calls.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `/repos/{repo_id}/files/{path}` and `/repos/{repoId}/files/{path}` → one key. */
export function erasePathParams(path) {
  return path.replace(/\{[^}]*\}/g, "{}");
}

/**
 * Compare `calls` ([{ method, path }]) with an OpenAPI document. Returns the
 * calls that are absent from the document and the calls it serves as deprecated.
 */
export function checkApiParity(calls, openapi) {
  const served = new Map();
  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      const upper = method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upper)) continue;
      served.set(`${upper} ${erasePathParams(path)}`, { path, deprecated: operation?.deprecated === true });
    }
  }
  const absent = [];
  const deprecated = [];
  for (const call of calls) {
    const hit = served.get(`${call.method} ${erasePathParams(call.path)}`);
    if (!hit) absent.push(call);
    else if (hit.deprecated) deprecated.push({ ...call, served_as: hit.path });
  }
  return { absent, deprecated, served: calls.length - absent.length };
}

function main() {
  const documentPath = process.argv[2];
  if (!documentPath) {
    process.stderr.write("usage: node scripts/check-api-parity.mjs <openapi.json>\n");
    process.exit(2);
  }
  const { calls } = JSON.parse(readFileSync(join(root, INVENTORY), "utf8"));
  const openapi = JSON.parse(readFileSync(documentPath, "utf8"));
  const result = checkApiParity(calls, openapi);
  for (const call of result.absent) {
    process.stderr.write(`absent from the server: ${call.method} ${call.path}\n`);
  }
  for (const call of result.deprecated) {
    process.stderr.write(`deprecated on the server: ${call.method} ${call.path} (served as ${call.served_as})\n`);
  }
  const failures = result.absent.length + result.deprecated.length;
  process.stdout.write(
    `${calls.length} CLI operations: ${result.served} served, ${result.absent.length} absent, ${result.deprecated.length} deprecated.\n`,
  );
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
