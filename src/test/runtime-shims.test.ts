import { afterEach, describe, expect, it } from "vitest";
import cmdShim from "cmd-shim";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { runtimeCommand } from "../local/runtime-command.js";
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
  const root = mkdtempSync(join(tmpdir(), "is npm runtime & %literal% !bang! "));
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

  it("does not call a nonzero version response usable", async () => {
    const f = await fixture("pi");
    writeFileSync(f.script, "#!/usr/bin/env node\nconsole.error('0.73.1'); process.exit(23);\n");
    expect(probeBinary(process.platform === "win32" ? f.cmd : f.script)).toMatchObject({ present: false, version: null });
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


describe("runtime invocation argument boundaries", () => {
  it("keeps POSIX/native invocations and argument arrays unchanged", () => {
    const args = ["hello & goodbye", "line one\nline two", "", "%PATH%", 'a"b'];
    expect(runtimeCommand(process.execPath, args)).toEqual({ command: process.execPath, args });
  });

  it.skipIf(process.platform !== "win32")("unwraps npm Node shims without a command shell, synchronously and asynchronously", async () => {
    const f = await fixture("claude");
    const marker = join(f.root, "must-not-exist.txt");
    const args = ["plain", "", "with spaces", 'a"b', "trailing\\", "%PATH%", "!PATH!", "one\ntwo", "雪", `& echo INJECTED > "${marker}"`, "| whoami", "^caret", "(parens)"];
    for (const bin of ["claude", f.cmd, ".\\claude.cmd"]) {
      const command = runtimeCommand(bin, args, f.env, f.root);
      expect(command.command.toLowerCase()).not.toContain("cmd.exe");
      const sync = spawnSync(command.command, command.args, { env: f.env, cwd: f.root, encoding: "utf8", timeout: 10_000 });
      expect(sync.status, sync.stderr).toBe(0);
      expect(JSON.parse(sync.stdout)).toEqual(args);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(command.command, command.args, { env: f.env, cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", part => { stdout += part; });
        child.stderr.on("data", part => { stderr += part; });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
      });
      expect(JSON.parse(output)).toEqual(args);
      expect(existsSync(marker)).toBe(false);
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("does not turn arbitrary batch text or a missing npm target into a shell command", async () => {
    const f = await fixture("pi");
    const arbitrary = join(f.root, "custom.cmd");
    writeFileSync(arbitrary, "@echo not an npm shim\r\n");
    expect(runtimeCommand(arbitrary, ["%PATH%"], f.env).command).toBe(arbitrary);
    expect(probeBinary(arbitrary, f.env).present).toBe(false);
    rmSync(f.script);
    expect(probeBinary(f.cmd, f.env).present).toBe(false);
  });
});
