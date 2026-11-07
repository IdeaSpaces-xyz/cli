import { afterEach, describe, expect, it } from "vitest";
import cmdShim from "cmd-shim";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { probeBinary } from "../local/probe-binary.js";
import { claudeStatusCommand } from "../claude/claude-status.js";
import { captureJson } from "./helpers.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fixture(name: string, stderrVersion = false) {
  const root = mkdtempSync(join(tmpdir(), "is npm runtime with spaces "));
  roots.push(root);
  const script = join(root, "provider.cjs");
  writeFileSync(script, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.${stderrVersion ? "error" : "log"}('${name === "pi" ? "0.73.1" : "2.1.319"}');
  process.exit(0);
}
if (process.argv.slice(2).join(' ') === 'auth status --json') {
  console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  process.exit(1);
}
console.log(JSON.stringify(process.argv.slice(2)));
`);
  chmodSync(script, 0o755);
  const bin = join(root, name);
  await cmdShim(script, bin);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = [root, originalPath].filter(Boolean).join(delimiter);
  return { root, script, bin, cmd: `${bin}.cmd`, env };
}

describe("installed runtime version probes", () => {
  it("keeps native executable discovery", () => {
    expect(probeBinary(process.execPath)).toMatchObject({ present: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });

  it("does not call a missing binary present", () => {
    expect(probeBinary(join(tmpdir(), "absent-runtime-318.exe"))).toMatchObject({ present: false, version: null });
  });

  it("reads a real executable's version from stderr, as Pi emits it", async () => {
    const f = await fixture("pi", true);
    expect(probeBinary(process.platform === "win32" ? f.cmd : f.script)).toMatchObject({ present: true, version: "0.73.1" });
  });

  for (const name of ["claude", "pi"]) {
    it.skipIf(process.platform !== "win32")(`finds a real npm ${name}.cmd through PATH and an explicit shim`, async () => {
      const f = await fixture(name, name === "pi");
      const version = name === "pi" ? "0.73.1" : "2.1.319";
      expect(probeBinary(name, f.env)).toMatchObject({ present: true, path: name, version });
      expect(probeBinary(f.cmd, f.env)).toMatchObject({ present: true, path: f.cmd, version });
    });
  }

  it.skipIf(process.platform !== "win32")("uses the same shim resolution for Claude's signed-out auth report", async () => {
    const f = await fixture("claude");
    process.env.PATH = f.env.PATH;
    for (const bin of ["claude", f.cmd]) {
      const result = await captureJson(() => claudeStatusCommand.run([], { "claude-bin": bin }, { json: true, quiet: true, yes: false, help: false }));
      expect(result.exit).toBe(0);
      expect(result.json).toMatchObject({ binary: { present: true, version: "2.1.319" }, login: { loggedIn: false, method: "none", detail: null }, ready: false });
    }
  });
});
