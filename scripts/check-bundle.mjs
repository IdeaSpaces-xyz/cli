import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Run after `npm run build`. Compare with HEAD rather than the working tree:
// npm ci runs prepare and can overwrite the checked-out executable before CI checks it.
const path = "bundle/ideaspaces.js";
let committed;
try {
  committed = execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });
} catch {
  throw new Error(`Cannot read ${path} from HEAD. Run this check in a git checkout after committing the bundle.`);
}
const rebuilt = readFileSync(path);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (!committed.equals(rebuilt)) {
  throw new Error(`${path} does not match the bundle committed at HEAD.\n` +
    `committed sha256: ${hash(committed)}\nrebuilt sha256:   ${hash(rebuilt)}\n` +
    "Run npm ci && npm run build, then commit the rebuilt bundle with its source.");
}
console.log(`${path} reproducible: sha256 ${hash(rebuilt)}`);
