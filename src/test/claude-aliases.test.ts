import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_ALIASES, aliasProbeArgs, resolveClaudeAliases, resolvedModel } from "../claude/claude-aliases.js";
import { getClaudeDefaults, probeClaudeModels } from "../claude/claude-models.js";

// A stand-in `claude` that answers the alias probe the way Claude Code 2.1.322
// does: a `system/init` naming the resolved model, then (for `/cost`) a local
// result. Its aliases resolve to ids no roster in this CLI has ever named, so a
// test that passes cannot be reading a typed list. Special aliases exercise the
// failure paths; every run records its argv and stdin, and its pid, in $LOG_DIR.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--model");
const ref = at >= 0 ? args[at + 1] : "";
const table = { "": "claude-opus-9-9", opus: "claude-opus-9-9", sonnet: "claude-sonnet-9-9", haiku: "claude-haiku-9-9", fable: "claude-fable-9-9", opusplan: "claude-sonnet-9-9" };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
const log = (extra) => fs.writeFileSync(process.env.LOG_DIR + "/" + (ref || "default") + ".json", JSON.stringify({ args, stdin, cwd: process.cwd(), pid: process.pid, ...extra }));
process.stdin.on("end", () => {
  log({});
  if (ref === "crash") { process.stderr.write("error: unknown option '--no-session-persistence'\\n"); process.exit(2); }
  if (ref === "slow") { setInterval(() => {}, 1000); return; }
  if (ref === "limit") { out({ type: "result", subtype: "success", is_error: true, result: "You have reached your limit" }); process.exit(1); }
  out({ type: "system", subtype: "init", session_id: "s", model: table[ref] ?? ref, cwd: process.cwd() });
  // Stay alive after init: the probe must stop the process itself.
  setTimeout(() => log({ outlived: true }), 2000);
  setInterval(() => {}, 1000);
});
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform === "win32")("resolveClaudeAliases against a stand-in claude", () => {
  let dir: string;
  let logs: string;
  let bin: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-aliases-"));
    logs = join(dir, "logs");
    await rm(logs, { recursive: true, force: true });
    await writeFile(join(dir, "fake-claude.cjs"), FAKE_CLAUDE);
    bin = join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-claude.cjs")}" "$@"\n`);
    await chmod(bin, 0o755);
    await import("node:fs/promises").then((fs) => fs.mkdir(logs, { recursive: true }));
    env = { ...process.env, LOG_DIR: logs };
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names each alias by the model the binary reports, ids no roster has seen", async () => {
    const resolved = await resolveClaudeAliases(bin, env);
    expect(resolved.map((r) => [r.ref, r.model])).toEqual([
      ["", "claude-opus-9-9"], ["opus", "claude-opus-9-9"], ["sonnet", "claude-sonnet-9-9"],
      ["haiku", "claude-haiku-9-9"], ["fable", "claude-fable-9-9"], ["opusplan", "claude-sonnet-9-9"],
    ]);
    expect(resolved.map((r) => r.ref)).toEqual([...CLAUDE_ALIASES]);
  });

  it("a new Claude model lists with no CLI release: probeClaudeModels reports it, the defaults give only its window", async () => {
    const { models, modelsDetail } = await probeClaudeModels({ present: true, path: bin, version: "2.1.322" }, env);
    const fable = models.find((m) => m.ref === "fable");
    expect(fable).toEqual({ ref: "fable", id: "claude-fable-9-9", name: "Fable 9.9", reported: true,
      contextWindow: 1_000_000, maxTokens: 128_000, window: "default" });
    expect(models.find((m) => m.isDefault)?.id).toBe("claude-opus-9-9");
    expect(modelsDetail).toBeNull();
    // Nothing listed came from a typed id: every one is what the stand-in said.
    expect(new Set(models.map((m) => m.id))).toEqual(new Set(["claude-opus-9-9", "claude-sonnet-9-9", "claude-haiku-9-9", "claude-fable-9-9"]));
  });

  it("loads nothing of the person's setup, sends only the local /cost, and saves no session", async () => {
    await resolveClaudeAliases(bin, env, { refs: ["haiku"] });
    const run = JSON.parse(await readFile(join(logs, "haiku.json"), "utf8"));
    expect(run.args).toEqual(aliasProbeArgs("haiku"));
    expect(run.args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", "--no-session-persistence"]));
    expect(run.stdin).toBe("/cost\n");
    expect(run.cwd).toMatch(/ideaspaces-claude-aliases-/);
    // The empty working folder is removed after.
    expect((await readdir(tmpdir())).filter((n) => n === run.cwd.split("/").pop())).toEqual([]);
  });

  it("stops each process at init, so nothing runs past it", async () => {
    await resolveClaudeAliases(bin, env, { refs: ["sonnet"] });
    const { pid } = JSON.parse(await readFile(join(logs, "sonnet.json"), "utf8"));
    await sleep(200);
    expect(alive(pid)).toBe(false);
    await sleep(2_100);
    expect(JSON.parse(await readFile(join(logs, "sonnet.json"), "utf8")).outlived).toBeUndefined();
  });

  it("leaves out an alias the binary echoes back, and says why", async () => {
    const [unknown] = await resolveClaudeAliases(bin, env, { refs: ["nonsense-alias"] });
    expect(unknown).toEqual({ ref: "nonsense-alias", model: null, detail: "Claude Code does not resolve --model nonsense-alias" });
  });

  it("reports a binary that exits before init, answers without one, or never starts, with its words", async () => {
    const [crash, limit, slow] = await resolveClaudeAliases(bin, env, { refs: ["crash", "limit", "slow"], timeoutMs: 1_500 });
    expect(crash.model).toBeNull();
    expect(crash.detail).toBe("Claude Code exited (2) before naming a model for --model crash: error: unknown option '--no-session-persistence'");
    expect(limit.model).toBeNull();
    expect(limit.detail).toBe("Claude Code answered --model limit without naming a model: You have reached your limit");
    expect(slow).toEqual({ ref: "slow", model: null, detail: "Claude Code did not name a model for --model slow within 2 s" });
    const { pid } = JSON.parse(await readFile(join(logs, "slow.json"), "utf8"));
    await sleep(200);
    expect(alive(pid)).toBe(false);
  });

  it("a missing binary resolves nothing and says it could not start", async () => {
    const [none] = await resolveClaudeAliases(join(dir, "no-such-claude"), env, { refs: ["opus"] });
    expect(none.model).toBeNull();
    expect(none.detail).toMatch(/could not start Claude Code for --model opus/);
  });
});

describe("resolvedModel", () => {
  it("keeps a reported id, drops an echo, an empty answer and a synthetic one", () => {
    expect(resolvedModel("fable", "claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(resolvedModel("fable", "fable")).toBeNull();
    expect(resolvedModel("", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolvedModel("opus", null)).toBeNull();
    expect(resolvedModel("opus", "<synthetic>")).toBeNull();
  });
});

describe("getClaudeDefaults is only defaults", () => {
  it("carries no model ids", () => {
    for (const version of [null, "2.0.5", "2.1.278", "2.1.305", "2.1.322"]) {
      expect(JSON.stringify(getClaudeDefaults(version))).not.toMatch(/claude-/);
    }
  });
});
