import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  findSpaceForMock,
  saveSpaceMock,
  snapshotMock,
  loadBaselineMock,
  saveBaselineMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  findSpaceForMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  snapshotMock: vi.fn(),
  loadBaselineMock: vi.fn(),
  saveBaselineMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadOptionalAuthConfig: loadConfigMock }));
vi.mock("../auth/spaces.js", () => ({
  findSpaceFor: findSpaceForMock,
  saveSpace: saveSpaceMock,
}));
vi.mock("../auth/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/api.js")>()),
  getSpaceCopySnapshot: snapshotMock,
}));
vi.mock("../fork-update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fork-update.js")>()),
  loadForkBaseline: loadBaselineMock,
  saveForkBaseline: saveBaselineMock,
}));

const { updateCommand } = await import("../commands/update.js");
const { UnauthorizedError } = await import("../auth/api.js");
const SOURCE = "n_ffffffffffffffffffffffff";
const ID = "n_aaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = `---\nnode_id: ${ID}\n---\nold\n`;
const NEW = `---\nnode_id: n_bbbbbbbbbbbbbbbbbbbbbbbb\n---\nnew\n`;
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let root: string;
let cwd: string;
let stdout: string[];
let stderr: string[];
let oldOut: typeof process.stdout.write;
let oldErr: typeof process.stderr.write;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "is-update-command-"));
  execFileSync("git", ["init"], { cwd: root });
  cwd = process.cwd();
  process.chdir(root);
  stdout = [];
  stderr = [];
  oldOut = process.stdout.write.bind(process.stdout);
  oldErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr.push(String(value));
    return true;
  }) as typeof process.stderr.write;
  for (const mock of [
    loadConfigMock,
    findSpaceForMock,
    saveSpaceMock,
    snapshotMock,
    loadBaselineMock,
    saveBaselineMock,
  ]) mock.mockReset();
  loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
  findSpaceForMock.mockReturnValue({
    repo_id: "repo_copy",
    slug: "guide",
    namespace: "alice",
    source_root_node_id: SOURCE,
    source_head: "a".repeat(40),
  });
  loadBaselineMock.mockReturnValue({
    source_root_node_id: SOURCE,
    source_head: "a".repeat(40),
    files: { "README.md": OLD },
    assets: {},
    conflicts: [],
  });
  writeFileSync(join(root, "README.md"), OLD);
  snapshotMock.mockResolvedValue({
    source_head: "b".repeat(40),
    markdown_file_count: 1,
    markdown_bytes: NEW.length,
    files: [{ path: "README.md", content: NEW }],
  });
});

afterEach(() => {
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

describe("update command", () => {
  it("previews without writing", async () => {
    const code = await updateCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ apply: false, writes: ["README.md"] });
    expect(saveBaselineMock).not.toHaveBeenCalled();
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed source response", async () => {
    snapshotMock.mockResolvedValue({ source_head: "bad", files: "nope" });

    const code = await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("invalid snapshot envelope");
    expect(saveBaselineMock).not.toHaveBeenCalled();
  });

  it("updates anonymously when no credentials exist", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test" });

    expect(await updateCommand.run([], {}, JSON_GLOBAL)).toBe(0);

    expect(snapshotMock.mock.calls[0][0]).toEqual({ apiUrl: "https://api.example.test" });
  });

  it("retries an expired credential once without Authorization", async () => {
    snapshotMock
      .mockRejectedValueOnce(new UnauthorizedError("expired"))
      .mockResolvedValueOnce({
        source_head: "b".repeat(40),
        markdown_file_count: 1,
        markdown_bytes: NEW.length,
        files: [{ path: "README.md", content: NEW }],
      });

    expect(await updateCommand.run([], {}, JSON_GLOBAL)).toBe(0);

    expect(snapshotMock.mock.calls.map((call) => call[0])).toEqual([
      { apiUrl: "https://api.example.test", apiKey: "k" },
      { apiUrl: "https://api.example.test" },
    ]);
  });

  it("fails neutrally without retry when source copy authority is unavailable", async () => {
    snapshotMock.mockRejectedValue(new Error("GET copy-snapshot → 404: Space not found"));

    const code = await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("may no longer be shared or allow Fork");
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(saveBaselineMock).not.toHaveBeenCalled();
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("fails closed when one source head returns different projected content", async () => {
    snapshotMock.mockResolvedValue({
      source_head: "a".repeat(40),
      markdown_file_count: 1,
      markdown_bytes: NEW.length,
      files: [{ path: "README.md", content: NEW }],
    });

    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(1);

    expect(stderr.join("")).toContain("changed without changing its source head");
    expect(readFileSync(join(root, "README.md"), "utf-8")).toBe(OLD);
    expect(saveBaselineMock).not.toHaveBeenCalled();
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("refuses to reconstruct a baseline after initialized state is lost", async () => {
    loadBaselineMock.mockReturnValue(null);
    findSpaceForMock.mockReturnValue({
      repo_id: "repo_copy",
      slug: "guide",
      namespace: "alice",
      source_root_node_id: SOURCE,
      source_head: "a".repeat(40),
      source_baseline_initialized: true,
    });

    const code = await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("baseline is missing");
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("persists the baseline before advancing the displayed source head", async () => {
    const code = await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true });

    expect(code).toBe(0);
    const canonicalRoot = realpathSync.native(process.cwd());
    expect(saveBaselineMock).toHaveBeenCalledWith(
      canonicalRoot,
      expect.objectContaining({ source_head: "b".repeat(40) }),
    );
    expect(saveSpaceMock).toHaveBeenCalledOnce();
    expect(saveSpaceMock.mock.calls[0][0]).toBe(canonicalRoot);
    expect(saveSpaceMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        source_head: "b".repeat(40),
        source_baseline_initialized: true,
      }),
    );
    expect(saveBaselineMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveSpaceMock.mock.invocationCallOrder[0],
    );
  });

  it("migrates an S3 asset baseline only on apply", async () => {
    mkdirSync(join(root, "_assets"));
    writeFileSync(join(root, "_assets", "picture.bin"), Buffer.from([0]));
    execFileSync("git", ["add", "README.md", "_assets/picture.bin"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "copy"],
      { cwd: root },
    );
    loadBaselineMock.mockReturnValue({
      source_root_node_id: SOURCE,
      source_head: "a".repeat(40),
      files: { "README.md": OLD },
      conflicts: [],
    });
    findSpaceForMock.mockReturnValue({
      repo_id: "repo_copy",
      slug: "guide",
      namespace: "alice",
      source_root_node_id: SOURCE,
      source_head: "a".repeat(40),
      source_baseline_initialized: true,
    });
    snapshotMock.mockResolvedValue({
      source_head: "a".repeat(40),
      markdown_file_count: 1,
      markdown_bytes: OLD.length,
      files: [{ path: "README.md", content: OLD }],
      asset_file_count: 1,
      asset_bytes: 1,
      assets: [{ path: "_assets/picture.bin", content_base64: "AQ==" }],
    });

    expect(await updateCommand.run([], {}, JSON_GLOBAL)).toBe(0);
    expect(saveBaselineMock).not.toHaveBeenCalled();

    stdout = [];
    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);
    expect(readFileSync(join(root, "_assets", "picture.bin"))).toEqual(Buffer.from([1]));
    expect(saveBaselineMock).toHaveBeenCalledWith(
      realpathSync.native(process.cwd()),
      expect.objectContaining({
        assets: { "_assets/picture.bin": expect.stringMatching(/^[0-9a-f]{64}$/) },
      }),
    );
  });

  it("performs no durable write when source, baseline, record, and worktree are aligned", async () => {
    writeFileSync(join(root, "README.md"), NEW);
    loadBaselineMock.mockReturnValue({
      source_root_node_id: SOURCE,
      source_head: "b".repeat(40),
      files: { "README.md": NEW },
      assets: {},
      conflicts: [],
    });
    findSpaceForMock.mockReturnValue({
      repo_id: "repo_copy",
      slug: "guide",
      namespace: "alice",
      source_root_node_id: SOURCE,
      source_head: "b".repeat(40),
      source_baseline_initialized: true,
    });

    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);

    expect(JSON.parse(stdout.join(""))).toMatchObject({ changed: false, worktree_changed: false });
    expect(saveBaselineMock).not.toHaveBeenCalled();
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("reports a recoverable partial when baseline persistence fails after apply", async () => {
    saveBaselineMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(1);

    expect(readFileSync(join(root, "README.md"), "utf-8")).toBe(OLD.replace("old", "new"));
    expect(stderr.join("")).toContain("reached the worktree");
    expect(stderr.join("")).toContain("Rerun the identical update");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("leaves the durable baseline ahead for registry-only retry when registry persistence fails", async () => {
    saveSpaceMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });

    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(1);

    expect(saveBaselineMock).toHaveBeenCalledOnce();
    expect(stderr.join("")).toContain("baseline is current");
    expect(stderr.join("")).toContain("repair it");
  });

  it("advances an unpublished fork baseline without inventing hosted fields", async () => {
    findSpaceForMock.mockReturnValue({
      kind: "unpublished_fork",
      root_node_id: "n_0123456789abcdef01234567",
      name: "Local Guide",
      source_root_node_id: SOURCE,
      source_head: "a".repeat(40),
      source_baseline_initialized: true,
    });

    expect(await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);

    expect(saveSpaceMock).toHaveBeenCalledWith(
      realpathSync.native(process.cwd()),
      expect.objectContaining({
        kind: "unpublished_fork",
        root_node_id: "n_0123456789abcdef01234567",
        source_head: "b".repeat(40),
        source_baseline_initialized: true,
      }),
    );
    const written = saveSpaceMock.mock.calls[0][1];
    expect(written).not.toHaveProperty("repo_id");
    expect(written).not.toHaveProperty("namespace");
  });
});
