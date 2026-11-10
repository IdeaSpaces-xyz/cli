import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Compare with HEAD: npm ci's prepare rebuild can overwrite checked-out artifacts.
for (const path of ["bundle/ideaspaces.js", "bundle/agent-tools.json", "bundle/agent-tools.schema.json"]) {
  let committed;
  try {
    committed = execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`Cannot read ${path} from HEAD. Commit the generated artifact with its source.`);
  }
  const rebuilt = readFileSync(path);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (!committed.equals(rebuilt)) throw new Error(`${path} does not match HEAD.\ncommitted sha256: ${hash(committed)}\nrebuilt sha256: ${hash(rebuilt)}\nRun npm ci && npm run build, then commit the rebuilt artifacts after their source.`);
  console.log(`${path} reproducible: sha256 ${hash(rebuilt)}`);
}
