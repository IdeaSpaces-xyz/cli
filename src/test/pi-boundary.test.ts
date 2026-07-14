import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The lean-core invariant: the universal CLI (src/commands/**) MUST NOT import
// the Pi connector (src/pi/**). Only the composition root (src/router.ts) wires
// the two — it injects the local-conversation ops and registers the Pi-runtime
// commands. This keeps @ideaspaces/cli's core Pi-free so the connector stays
// sectionable/extractable. This test is the enforcement (the CLI has no ESLint).

const commandsDir = join(process.cwd(), "src", "commands");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Relative import specifiers in a source file (both `import … from "x"` and
 *  `import("x")`). */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** Does a relative specifier resolve into the `pi/` directory? (a path segment
 *  exactly `pi`, e.g. `../pi`, `../pi/index.js`, `./pi/local-agent.js`). */
function pointsIntoPi(spec: string): boolean {
  if (!spec.startsWith(".")) return false; // package import, not our tree
  return spec.split("/").some((seg) => seg === "pi");
}

describe("Pi boundary — core commands never import src/pi", () => {
  const files = walk(commandsDir);

  it("finds command files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(file.indexOf("src/"));
    it(`${rel} imports nothing from src/pi`, () => {
      const offending = importSpecifiers(readFileSync(file, "utf8")).filter(pointsIntoPi);
      expect(offending, `${rel} imports the Pi connector: ${offending.join(", ")}`).toEqual([]);
    });
  }
});
