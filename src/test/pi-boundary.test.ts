import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The lean-core invariant: the universal CLI (src/commands/**) MUST NOT import
// a local-runtime connector — the Pi connector (src/pi/**) or the Claude Code
// connector (src/claude/**). Only the composition root (src/router.ts) wires
// them — it injects the local-conversation ops and registers the Pi-runtime
// commands. This keeps @ideaspaces/cli's core runtime-free so each connector
// stays sectionable/extractable. This test is the enforcement (the CLI has no ESLint).

const srcDir = join(process.cwd(), "src");
const commandsDir = join(srcDir, "commands");

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

const CONNECTORS = ["pi", "claude"];

/** Does a relative specifier resolve into a connector directory? (a path segment
 *  exactly `pi` or `claude`, e.g. `../pi`, `../pi/index.js`, `./claude/local-agent.js`). */
function pointsIntoConnector(spec: string): boolean {
  if (!spec.startsWith(".")) return false; // package import, not our tree
  return spec.split("/").some((seg) => CONNECTORS.includes(seg));
}

describe("Runtime boundary — core commands never import src/pi or src/claude", () => {
  const files = walk(commandsDir);

  it("finds command files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(file.indexOf("src/"));
    it(`${rel} imports nothing from src/pi or src/claude`, () => {
      const offending = importSpecifiers(readFileSync(file, "utf8")).filter(pointsIntoConnector);
      expect(offending, `${rel} imports a runtime connector: ${offending.join(", ")}`).toEqual([]);
    });
  }
});

// The connectors are peers, not a stack: neither reaches into the other. What
// both need — JSONL framing, the workspace harvest, map and launch orientation,
// the `--runtime` dispatcher — lives in src/local/, so either connector can be
// sectioned or extracted without the other.
describe("Connector independence — src/pi and src/claude never import each other", () => {
  for (const [own, other] of [["pi", "claude"], ["claude", "pi"]] as const) {
    for (const file of walk(join(srcDir, own))) {
      const rel = file.slice(file.indexOf("src/"));
      it(`${rel} imports nothing from src/${other}`, () => {
        const offending = importSpecifiers(readFileSync(file, "utf8"))
          .filter((spec) => spec.startsWith(".") && spec.split("/").some((seg) => seg === other));
        expect(offending, `${rel} reaches into the ${other} connector: ${offending.join(", ")}`).toEqual([]);
      });
    }
  }
});
