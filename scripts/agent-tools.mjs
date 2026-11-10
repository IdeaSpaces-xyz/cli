import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCatalog } from "../dist/agent-tools/catalog.js";

export function generateCatalog() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const protocol = lock.packages["node_modules/@ideaspaces/protocol"];
  const protocolCommit = protocol.resolved.split("#").at(-1);
  if (!/^[a-f0-9]{40}$/.test(protocolCommit)) throw new Error("Catalog needs an exact protocol commit from the lockfile");
  // Source provenance, not the later artifact-only commit or merge-group commit.
  // CI checks out full history so this remains reproducible in PRs and the queue.
  const sourcePaths = ["src", "scripts", "build.mjs", "package.json", "package-lock.json", "tsconfig.json"];
  const commit = execFileSync("git", ["log", "-1", "--format=%H", "--", ...sourcePaths], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Catalog needs a Git source commit; build from a checkout");
  const catalog = buildCatalog({ version: pkg.version, commit }, { version: protocol.version, commit: protocolCommit });
  const schema = JSON.parse(readFileSync("src/agent-tools/agent-tools.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  if (!validate(catalog)) throw new Error(`Invalid agent-tools catalog: ${JSON.stringify(validate.errors)}`);
  const bytes = JSON.stringify(catalog, null, 2) + "\n";
  writeFileSync("bundle/agent-tools.json", bytes);
  writeFileSync("bundle/agent-tools.schema.json", JSON.stringify(schema, null, 2) + "\n");
  console.log(`Agent-tools: ${catalog.entries.length} entries, ${catalog.digest}; unbounded: ${catalog.entries.filter(e => e.bound === "unbounded").map(e => e.id).join(", ")}`);
  return catalog;
}
