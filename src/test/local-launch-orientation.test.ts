import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localLaunchOrientation } from "../pi/launch-orientation.js";
import { localConversationOps } from "../pi/local-conversation-ops.js";
import type { Output } from "../output.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "local-position-")); roots.push(root);
  const pov = join(root, "agent"); const work = join(root, "material");
  mkdirSync(pov); mkdirSync(work); writeFileSync(join(work, "note.md"), "Material");
  return { root, pov, work };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Local launch orientation", () => {
  it("carries validated coordinates without embedding the material", () => {
    const { pov, work } = fixture();
    const text = localLaunchOrientation(pov, work, "note.md");
    expect(text).toContain('"focus":"note.md"');
    expect(text).toContain("[Local session position]");
    expect(text).not.toContain("Material");
  });
  it("rejects missing, absolute and escaping focus before spawning", () => {
    const { pov, work } = fixture();
    for (const focus of ["../agent", "/etc/passwd", "missing.md"]) {
      expect(() => localLaunchOrientation(pov, work, focus)).toThrow();
    }
  });
  it.skipIf(process.platform === "win32")("rejects symlink escapes", () => {
    const { pov, work } = fixture();
    symlinkSync(pov, join(work, "outside"));
    expect(() => localLaunchOrientation(pov, work, "outside")).toThrow("outside");
  });
  it.skipIf(process.platform === "win32")("spawns with orientation but sends only the original question over RPC", async () => {
    const { root, pov, work } = fixture();
    const fake = join(root, "pi.mjs");
    writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
const orientation = args[args.indexOf('--append-system-prompt') + 1];
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += String(chunk);
  while (buffer.includes('\\n')) {
    const n = buffer.indexOf('\\n'); const line = buffer.slice(0,n); buffer = buffer.slice(n+1);
    if (!line) continue;
    const c = JSON.parse(line);
    if (c.type === 'get_state') console.log(JSON.stringify({type:'response',command:'get_state',success:true,data:{sessionName:'test'}}));
    if (c.type === 'prompt') {
      console.log(JSON.stringify({type:'response',command:'prompt',success:true}));
      console.log(JSON.stringify({type:'agent_start'}));
      console.log(JSON.stringify({type:'turn_start'}));
      console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:JSON.stringify({message:c.message,orientation,cwd:process.cwd()})}}));
      console.log(JSON.stringify({type:'agent_end'}));
    }
  }
});
`);
    chmodSync(fake, 0o755);
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
    const errors: string[] = [];
    const output: Output = { result() {}, log() {}, progress() {}, error(text) { errors.push(text); } };
    const result = await localConversationOps.send({
      context: pov, "working-root": work, focus: "note.md", message: "Hey, I'm working on this one",
      ext: "/fake/extensions", "pi-bin": fake, "session-dir": join(work, ".pi", "sessions"),
    }, output);
    expect(result).toBe(0); expect(errors).toEqual([]);
    const event = stdout.trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "text_delta");
    const received = JSON.parse(event.delta);
    expect(received.message).toBe("Hey, I'm working on this one");
    expect(received.orientation).toContain('"focus":"note.md"');
    expect(received.orientation).toContain("[Local session position]");
    expect(received.cwd.endsWith("/agent")).toBe(true);
  });
});
