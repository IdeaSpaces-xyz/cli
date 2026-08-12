import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
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

  it("fails closed when source copy authority is unavailable", async () => {
    snapshotMock.mockRejectedValue(new Error("GET copy-snapshot → 404"));

    const code = await updateCommand.run([], {}, { ...JSON_GLOBAL, yes: true });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("update channel is unavailable");
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
    expect(saveBaselineMock).toHaveBeenCalledWith(
      process.cwd(),
      expect.objectContaining({ source_head: "b".repeat(40) }),
    );
    expect(saveSpaceMock).toHaveBeenCalledOnce();
    expect(saveSpaceMock.mock.calls[0][0]).toBe(process.cwd());
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
});
