import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAP_DEPTHS, assembleContentLook, gitState, parseMap } from "@ideaspaces/protocol";
import { loadConfig } from "../auth/credentials.js";
import { lookCommand, projectPortableMap } from "../commands/look.js";
import { appendPost, createThread } from "../local/threads.js";
import type { GlobalFlags } from "../types.js";

vi.mock("../auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/credentials.js")>()),
  loadConfig: vi.fn(() => null),
}));

const JSON_FLAGS: GlobalFlags = {
  json: true,
  quiet: true,
  yes: false,
  help: false,
};
const ROOT_NODE_ID = "n_0123456789abcdef01234567";

let root: string;
let originalCwd: string;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function runLook(
  args: string[],
  flags: Record<string, string | boolean> = {},
  global: GlobalFlags = JSON_FLAGS,
): Promise<{ exit: number; data: any; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await lookCommand.run(args, flags, global);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  const out = stdout.join("");
  return {
    exit,
    data: global.json && out ? JSON.parse(out) : null,
    stdout: out,
    stderr: stderr.join(""),
  };
}

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-look-")));
  originalCwd = process.cwd();
  process.chdir(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "look@example.com"]);
  git(["config", "user.name", "Look Test"]);
  await fs.mkdir(join(root, "_agent"), { recursive: true });
  await fs.writeFile(
    join(root, "_agent", "agreement.md"),
    `---\nroot_node_id: ${ROOT_NODE_ID}\n---\n# Agreement\n\nAGREEMENT SENTINEL\n`,
  );
  await fs.writeFile(
    join(root, "_agent", "foundation.md"),
    `---\nroot_node_id: ${ROOT_NODE_ID}\nsummary: Foundation compatibility.\n---\n# Foundation\n\nFOUNDATION SENTINEL\n`,
  );
  await fs.mkdir(join(root, "notes"), { recursive: true });
  await fs.writeFile(
    join(root, "notes", "decision.md"),
    "---\nname: Decision\nsummary: The selected boundary.\n---\n# Decision\n\nBody.\n\n## Evidence\n\nProof.\n",
  );
  await fs.mkdir(join(root, "docs", "sub"), { recursive: true });
  await fs.writeFile(
    join(root, "docs", "README.md"),
    "---\nname: Documents\nsummary: Working documents.\n---\n# Documents\n\nStart here.\n",
  );
  await fs.writeFile(join(root, "docs", "alpha.md"), "---\nsummary: Alpha.\n---\n# Alpha\n");
  await fs.writeFile(join(root, "docs", "sub", "beta.md"), "# Beta\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
  vi.mocked(loadConfig).mockReturnValue(null);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

describe("ideaspaces look", () => {
  it("reads a Thread folder through five canonical look rungs", async () => {
    const thread = createThread("decision", "Current decision", root);
    const first = appendPost(thread.path, { body: "Private body", author: "Integrator", name: "First", summary: "One finding" });
    const second = appendPost(thread.path, { body: "Second body", author: "Scout", name: "Second", summary: "Next finding", replyTo: [first.post.id] });

    const named = await runLook(["_threads/decision"], { depth: "name" });
    expect(named.exit, named.stderr).toBe(0);
    expect(named.data.target.name).toBe("Current decision");
    expect(named.data.target.children).toBeUndefined();
    expect(named.stdout).not.toContain("Private body");
    expect(named.data.kind).toBe("content-look");
    expect(named.data.schema).not.toBe("ideaspaces.local-thread.open.v2");

    const withSlash = await runLook(["_threads/decision/"], { depth: "name" });
    expect(withSlash.exit, withSlash.stderr).toBe(0);
    expect(withSlash.data.target.name).toBe("Current decision");

    const summary = await runLook(["_threads/decision"], { depth: "summary" });
    expect(summary.exit, summary.stderr).toBe(0);
    expect(summary.data.target.name).toBe("Current decision");

    const children = await runLook(["_threads/decision"], { depth: "children" });
    expect(children.exit, children.stderr).toBe(0);
    expect(children.data.target.children).toHaveLength(2);

    const full = await runLook(["_threads/decision"], { depth: "full" });
    expect(full.exit, full.stderr).toBe(0);
    expect(full.data.target.children).toHaveLength(2);
    const asText = await runLook(["_threads/decision"], { depth: "children" }, { ...JSON_FLAGS, json: false });
    expect(asText.exit, asText.stderr).toBe(0);
    expect(asText.stdout).toContain("Current decision");
    expect(asText.stderr).toBe("");
    const contracted = await runLook(["_threads/decision"], { contract: "agreement" });
    expect(contracted.exit, contracted.stderr).toBe(0);
    expect(contracted.data.kind).toBe("content-look");
    git(["add", "."]);
    git(["commit", "-q", "-m", "thread"]);
    const pinned = await runLook(["_threads/decision"], { pin: git(["rev-parse", "HEAD"]), depth: "children" });
    expect(pinned.exit, pinned.stderr).toBe(0);
    expect(pinned.data.target.children).toHaveLength(2);
    const unknown = await runLook(["_threads/decision"], { typo: "value" });
    expect(unknown.exit).toBe(1);
    expect(unknown.stderr).toContain("Unknown flag for look: --typo");
    const cursorMisuse = await runLook(["_threads/decision"], { since: second.post.id });
    expect(cursorMisuse.exit).toBe(1);
    expect(cursorMisuse.stderr).toContain("children or full depth");
    const unread = await runLook(["_threads/decision"], { new: true });
    expect(unread.exit).toBe(1);
    expect(unread.stderr).toContain("threads open --new");
    const byId = await runLook(["_threads/decision"], { post: first.post.id, depth: "full" });
    expect(byId.exit, byId.stderr).toBe(0);
    expect(byId.data.target.position).toBe(`_threads/decision/${first.post.path}`);
    expect(byId.data.target.surface).toContain("Private body");
    const shorthand = await runLook(["_threads/decision"], { post: first.post.id.slice(0, 12), depth: "summary" });
    expect(shorthand.exit, shorthand.stderr).toBe(0);
    expect(shorthand.data.target.position).toBe(`_threads/decision/${first.post.path}`);
    const byRoot = await runLook([], { post: first.post.id, depth: "summary" });
    expect(byRoot.exit, byRoot.stderr).toBe(0);
    expect(byRoot.data.target.position).toBe(`_threads/decision/${first.post.path}`);
  }, 30_000); // Pinned Thread look and fixture Git startup can exceed 5s on Windows.

  it("pages 58 Thread posts and opens the Engine fix id at an authored Map pin from outside the checkout", async () => {
    const dir = join(root, "_threads", "engine");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "README.md"), "# Engine\n");
    const fixId = "msg_75cc2f37-e925-48e0-a801-c0ac7920c8be";
    for (let i = 0; i < 58; i++) {
      const id = i === 55 ? fixId : `msg_${String(i).padStart(8, "0")}-fixture`;
      await fs.writeFile(join(dir, `${String(i).padStart(2, "0")}-post.md`),
        `---\nid: ${id}\nname: ${i === 55 ? "Dev-run fix" : `Post ${i}`}\n---\n${i === 55 ? "The panic was fixed." : `Body ${i}`}\n`);
    }
    git(["add", "."]); git(["commit", "-q", "-m", "Thread posts"]);
    const pin = git(["rev-parse", "HEAD"]);
    const first = await runLook(["_threads/engine"], { depth: "children", limit: "50", order: "older" });
    expect(first.exit, first.stderr).toBe(0);
    expect(first.data.portable).toBe(true); // Recheck must use this same page, not a different first-page cap.
    expect(first.data.target.page).toEqual({ total: 58, shown: 50, order: "older", nextCursor: "49-post.md" });
    const next = await runLook(["_threads/engine"], { depth: "children", limit: "10", since: first.data.target.page.nextCursor });
    expect(next.exit, next.stderr).toBe(0);
    expect(next.data.target.page).toEqual({ total: 58, shown: 8, order: "older" });
    expect(next.data.target.children.map((child: { name: string }) => child.name)).toContain("Dev-run fix");
    const pinned = await runLook(["_threads/engine"], { depth: "children", limit: "3", order: "newer", pin });
    expect(pinned.exit, pinned.stderr).toBe(0);
    expect(pinned.data.target.page).toEqual({ total: 58, shown: 3, order: "newer", nextCursor: "55-post.md" });
    const pinnedId = await runLook(["_threads/engine"], { pin, post: "msg_75cc2f37", depth: "full" });
    expect(pinnedId.exit, pinnedId.stderr).toBe(0);
    expect(pinnedId.data.target.position).toBe("_threads/engine/55-post.md");
    const byId = await runLook(["_threads/engine"], { post: "msg_75cc2f37", depth: "full" });
    expect(byId.exit, byId.stderr).toBe(0);
    expect(byId.data.target.position).toBe("_threads/engine/55-post.md");
    expect(byId.data.target.surface).toContain("panic was fixed");
    const byRoot = await runLook([], { post: fixId, depth: "summary" });
    expect(byRoot.exit, byRoot.stderr).toBe(0);
    expect(byRoot.data.target.position).toBe("_threads/engine/55-post.md");
    const map = join(root, "engine.map.md");
    await fs.writeFile(map, `---\nname: Engine\nmap:\n  roots:\n    - root_node_id: ${ROOT_NODE_ID}\n      sha: ${pin}\n  members:\n    - root: 0\n      position: _threads/engine/msg_75cc2f37\n      depth: full\n---\nPinned selection\n`);
    const outside = realpathSync.native(await mkdtemp(join(tmpdir(), "is-cli-look-outside-")));
    try {
      process.chdir(outside);
      const address = await runLook([`@${ROOT_NODE_ID}//_threads/engine/msg_75cc2f37`], { map, at: "pin", depth: "full" });
      expect(address.exit, address.stderr).toBe(0);
      expect(address.data.target.position).toBe("_threads/engine/55-post.md");
      expect(address.data.text).toContain("panic was fixed");
      const virtual = `@${ROOT_NODE_ID}//_threads/engine/msg_75cc2f37`;
      const pagedId = await runLook([virtual], { map, at: "pin", depth: "children", limit: "1" });
      expect(pagedId.exit).toBe(1);
      expect(pagedId.stderr).toContain("post-id address selects one post");
      const both = await runLook([virtual], { map, at: "pin", post: fixId });
      expect(both.exit).toBe(1);
      expect(both.stderr).toContain("not both");
      const wrongPinForm = await runLook([virtual], { map, pin, depth: "full" });
      expect(wrongPinForm.exit).toBe(1);
      expect(wrongPinForm.stderr).toContain("--pin reads a path");
    } finally { process.chdir(root); await rm(outside, { recursive: true, force: true }); }
    for (const flags of [{ post: fixId, limit: "1" }, { post: fixId, since: "49-post.md" }, { post: fixId, order: "newer" }]) {
      const conflict = await runLook(["_threads/engine"], flags);
      expect(conflict.exit).toBe(1);
      expect(conflict.stderr).toContain("omit limit, since and order");
    }
    for (const flags of [{ order: "random", depth: "children" }, { since: "", depth: "children" }, { post: "" }]) {
      const invalid = await runLook(["_threads/engine"], flags);
      expect(invalid.exit).toBe(1);
      expect(invalid.stderr).toContain("--");
    }
    const stale = await runLook(["_threads/engine"], { depth: "children", since: "gone.md", pin });
    expect(stale.exit).toBe(1);
    expect(stale.data.status).toBe("read_error");
    expect(stale.stderr).toContain("cursor");
    const missing = await runLook(["_threads/engine"], { post: "msg_absent" });
    expect(missing.exit).toBe(1);
    expect(missing.data.status).toBe("unresolved");
    await fs.mkdir(join(root, "_threads", "copy"));
    await fs.writeFile(join(root, "_threads", "copy", "copy.md"), `---\nid: ${fixId}\n---\nCopy\n`);
    const ambiguous = await runLook([], { post: fixId });
    expect(ambiguous.exit).toBe(1);
    expect(ambiguous.data.status).toBe("ambiguous");
  }, 30_000);

  it("reads the Agreement by path as reference content", async () => {
    const read = await runLook(["_agent/agreement.md"], { depth: "full" });
    expect(read.exit, read.stderr).toBe(0);
    expect(read.data.target.position).toBe("_agent/agreement.md");
    expect(read.stdout).toContain("AGREEMENT SENTINEL");
    const rejected = await runLook(["notes/decision.md"], { post: "msg_example" });
    expect(rejected.exit).toBe(1);
    expect(rejected.stderr).toContain("Select a Thread folder");
    expect(rejected.data.status).toBe("invalid_post_scope");
  });

  it("defaults to Agreement summary and emits one valid portable Map", async () => {
    const cwd = process.cwd();
    const result = await runLook(["notes/decision.md"]);

    expect(result.exit, result.stderr).toBe(0);
    expect(process.cwd()).toBe(cwd);
    expect(result.data).toMatchObject({
      kind: "content-look",
      source: "local-working-tree",
      depth: "summary",
      portable: true,
      dirty: false,
      local_only_paths: [],
      reference: {
        contractRole: "reference",
        contractSource: "agreement",
        tree: null,
      },
      target: {
        placement: "history",
        position: "notes/decision.md",
        depth: "summary",
        name: "Decision",
        summary: "The selected boundary.",
      },
      projection: {
        root: { root_node_id: ROOT_NODE_ID },
        member: { position: "notes/decision.md", depth: "summary" },
      },
      map: {
        roots: [{ root_node_id: ROOT_NODE_ID }],
        members: [{ root: 0, position: "notes/decision.md", depth: "summary" }],
      },
    });
    expect(result.data.projection.root.local_path).toBe(result.data.reference.position.repoRoot);
    expect(parseMap(result.data.map).status).toBe("valid");
    expect(result.data.text).toContain("contract role: reference — read, never composed");
    expect(result.data.text).toContain("AGREEMENT SENTINEL");
    expect(result.data.text).not.toContain("FOUNDATION SENTINEL");
  });

  it("passes all five canonical rungs through the protocol reader", async () => {
    for (const depth of MAP_DEPTHS) {
      const result = await runLook(["notes/decision.md"], { depth });
      expect(result.exit, `${depth}: ${result.stderr}`).toBe(0);
      expect(result.data.target.depth).toBe(depth);
      expect(result.data.target.member.depth).toBe(depth);
    }

    const children = await runLook(["notes/decision.md"], { depth: "children" });
    expect(children.data.target.children.map((child: { name: string }) => child.name))
      .toEqual(["Decision", "Evidence"]);
    expect(children.data.target).not.toHaveProperty("surface");

    const full = await runLook(["notes/decision.md"], { depth: "full" });
    expect(full.data.target.surface).toContain("# Decision");
    expect(full.data.target).not.toHaveProperty("children");
  }, 20_000);

  it("returns directory surface plus bounded children at full", async () => {
    const result = await runLook(["docs"], { depth: "full", limit: "1" });

    expect(result.exit, result.stderr).toBe(0);
    expect(result.data.target).toMatchObject({
      kind: "directory",
      name: "Documents",
      summary: "Working documents.",
      surface: "# Documents\n\nStart here.\n",
      omittedChildren: 1,
      children: [{ kind: "directory", name: "sub", position: "docs/sub" }],
    });
    expect(result.data.target.children.some((child: { name: string }) => child.name === "README.md"))
      .toBe(false);
  });

  it("keeps explicit Foundation selection isolated", async () => {
    const result = await runLook(["notes/decision.md"], { contract: "foundation" });

    expect(result.exit, result.stderr).toBe(0);
    expect(result.data.reference.contractSource).toBe("foundation");
    expect(result.data.text).toContain("Foundation compatibility.");
    expect(result.data.text).not.toContain("AGREEMENT SENTINEL");
  });

  it("does not treat an ignored but nonexistent README as observed local Content", async () => {
    await fs.writeFile(join(root, ".gitignore"), "README.md\n");
    await fs.mkdir(join(root, "without-readme"));
    await fs.writeFile(join(root, "without-readme", "child.md"), "# Child\n");
    git(["add", ".gitignore", "without-readme/child.md"]);
    git(["commit", "-q", "-m", "add directory without a surface"]);

    const result = await runLook(["without-readme"], { depth: "children" });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.data).toMatchObject({
      portable: true,
      dirty: false,
      local_only_paths: [],
    });
    expect(result.data.target).not.toHaveProperty("surface");
    expect(result.data.map).toBeDefined();
  });

  it("fails closed to a local projection when the root is dirty or the target is ignored", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Changed\n");
    const dirty = await runLook(["notes/decision.md"], { depth: "full" });
    expect(dirty.exit, dirty.stderr).toBe(0);
    expect(dirty.data).toMatchObject({ portable: false, dirty: true });
    expect(dirty.data).not.toHaveProperty("map");

    git(["checkout", "--", "notes/decision.md"]);
    await fs.writeFile(join(root, ".gitignore"), "ignored.md\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "ignore local note"]);
    await fs.writeFile(join(root, "ignored.md"), "# Private\n");
    const ignored = await runLook(["ignored.md"], { depth: "name" });
    expect(ignored.exit, ignored.stderr).toBe(0);
    expect(ignored.data).toMatchObject({
      portable: false,
      dirty: true,
      local_only_paths: ["ignored.md"],
    });
    expect(ignored.data).not.toHaveProperty("map");
  });

  it("surfaces portability state in human output", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Changed\n");
    const result = await runLook(
      ["notes/decision.md"],
      { depth: "full" },
      { ...JSON_FLAGS, json: false, quiet: false },
    );

    expect(result.exit, result.stderr).toBe(0);
    expect(result.stdout).toContain("Look:\n  position: notes/decision.md");
    expect(result.stdout).toContain(
      "Map: local projection only — working tree differs from HEAD",
    );
  });

  it("fails portable projection closed when HEAD changes during verification", async () => {
    const looked = await assembleContentLook({
      position: join(root, "notes", "decision.md"),
      depth: "summary",
      contractSource: "agreement",
    });
    expect(looked?.status).toBe("ok");
    if (!looked || looked.status !== "ok") return;
    const actual = await gitState(root);
    let reads = 0;
    const projection = await projectPortableMap(looked, {
      readGitState: async () => ({
        ...actual,
        headSha: reads++ === 0 ? actual.headSha : "f".repeat(40),
      }),
    });

    expect(projection).toMatchObject({
      portable: false,
      issue: "The target or Git HEAD changed while verifying the portable Map",
    });
    expect(projection).not.toHaveProperty("map");
  });

  it("reports invalid, remote, missing, and non-Content targets through the error channel", async () => {
    expect((await runLook(["notes/decision.md"], { depth: "deep" })).stderr)
      .toContain("--depth must be one of");
    expect((await runLook(["notes/decision.md"], { contract: "both" })).stderr)
      .toContain("--contract must be");
    expect((await runLook(["https://ideaspaces.xyz/repos/n_example"])).stderr)
      .toContain("Remote look is not available yet");
    expect((await runLook(["missing.md"])).stderr).toContain("No such path");
    await fs.writeFile(join(root, "data.txt"), "plain data");
    expect((await runLook(["data.txt"])).stderr).toContain("Not a Content target");
  });
});
