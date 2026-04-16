import { describe, it, expect, vi, beforeEach } from "vitest";
import { SdkError } from "@ideaspaces/sdk";
import { runCommand, makeMockClient, MOCK_ROUTES } from "./helpers.js";

// Mock initClient to return our mock client
const mockClient = makeMockClient();
vi.mock("../client.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../client.js")>();
  return {
    ...orig,
    initClient: vi.fn().mockResolvedValue(mockClient),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// Import commands AFTER mocking
const { navigateCommand } = await import("../commands/navigate.js");
const { searchCommand } = await import("../commands/search.js");
const { readCommand } = await import("../commands/read.js");
const { writeCommand } = await import("../commands/write.js");
const { awarenessCommand } = await import("../commands/awareness.js");

// ─── navigate ──────────────────────────────────────────────────────

describe("navigate", () => {
  it("shows tree at root", async () => {
    const { exitCode, stdout } = await runCommand(navigateCommand);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(root)");
    expect(stdout).toContain("core/");
    expect(stdout).toContain("about.md");
  });

  it("shows agent context", async () => {
    const { stdout } = await runCommand(navigateCommand);
    expect(stdout).toContain("Direction:");
    expect(stdout).toContain("now");
    expect(stdout).toContain("purpose");
  });

  it("returns JSON with --json", async () => {
    const { exitCode, stdout } = await runCommand(navigateCommand, [], {}, { json: true });
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.readme).toBe("# My Space");
    expect(data.children).toHaveLength(2);
  });
});

// ─── search ────────────────────────────────────────────────────────

describe("search", () => {
  it("returns results with scores", async () => {
    const { exitCode, stdout } = await runCommand(searchCommand, ["MCP"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.95");
    expect(stdout).toContain("core/about.md");
    expect(stdout).toContain("About");
  });

  it("returns JSON with --json", async () => {
    const { exitCode, stdout } = await runCommand(searchCommand, ["MCP"], {}, { json: true });
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].score).toBe(0.95);
  });

  it("errors without query", async () => {
    const { exitCode, stderr } = await runCommand(searchCommand);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});

// ─── read ──────────────────────────────────────────────────────────

describe("read", () => {
  it("shows content and metadata", async () => {
    const { exitCode, stdout } = await runCommand(readCommand, ["core/about.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Node: /n/n_abc");
    expect(stdout).toContain("Tags: core");
    expect(stdout).toContain("# About");
  });

  it("returns JSON with --json", async () => {
    const { exitCode, stdout } = await runCommand(readCommand, ["core/about.md"], {}, { json: true });
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.node_id).toBe("n_abc");
    expect(data.content).toContain("# About");
  });

  it("errors without path", async () => {
    const { exitCode, stderr } = await runCommand(readCommand);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});

// ─── write ─────────────────────────────────────────────────────────

describe("write", () => {
  it("writes content and shows result", async () => {
    const { exitCode, stdout } = await runCommand(
      writeCommand,
      ["test.md"],
      { name: "Test", content: "# Test\nHello" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Written: test.md");
    expect(stdout).toContain("Node: /n/n_new");
    expect(stdout).toContain("Commit: def456");
  });

  it("returns JSON with --json", async () => {
    const { exitCode, stdout } = await runCommand(
      writeCommand,
      ["test.md"],
      { name: "Test", content: "# Hello" },
      { json: true },
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.path).toBe("test.md");
    expect(data.commit_sha).toBe("def456");
  });

  it("defaults if_match from latest file sha", async () => {
    const readSpy = vi.spyOn(mockClient, "readFile").mockResolvedValue({
      data: {
        path: "test.md",
        node_id: "n_abc",
        content: "# Old",
        total_lines: 1,
        frontmatter: { name: "Test" },
        node_type: "note",
        tags: [],
        attached_to: [],
        last_commit_sha: "abc123",
      },
      meta: { requestMs: 1, retries: 0 },
    } as any);
    const writeSpy = vi.spyOn(mockClient, "writeFile").mockResolvedValue({
      data: { path: "test.md", node_id: "n_new", commit_sha: "def456" },
      meta: { requestMs: 1, retries: 0 },
    } as any);

    const { exitCode } = await runCommand(
      writeCommand,
      ["test.md"],
      { content: "# New", name: "Test" },
    );

    expect(exitCode).toBe(0);
    expect(readSpy).toHaveBeenCalledWith("test.md");
    expect(writeSpy).toHaveBeenCalledWith(
      "test.md",
      expect.objectContaining({ if_match: "abc123" }),
    );
  });

  it("skips pre-read and if_match when --force is set", async () => {
    const readSpy = vi.spyOn(mockClient, "readFile");
    const writeSpy = vi.spyOn(mockClient, "writeFile").mockResolvedValue({
      data: { path: "test.md", node_id: "n_new", commit_sha: "def456" },
      meta: { requestMs: 1, retries: 0 },
    } as any);

    const { exitCode } = await runCommand(
      writeCommand,
      ["test.md"],
      { content: "# New", name: "Test", force: true },
    );

    expect(exitCode).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      "test.md",
      expect.objectContaining({ if_match: undefined }),
    );
  });

  it("uses explicit --if-match without pre-read", async () => {
    const readSpy = vi.spyOn(mockClient, "readFile");
    const writeSpy = vi.spyOn(mockClient, "writeFile").mockResolvedValue({
      data: { path: "test.md", node_id: "n_new", commit_sha: "def456" },
      meta: { requestMs: 1, retries: 0 },
    } as any);

    const { exitCode } = await runCommand(
      writeCommand,
      ["test.md"],
      { content: "# New", name: "Test", "if-match": "feedface" },
    );

    expect(exitCode).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      "test.md",
      expect.objectContaining({ if_match: "feedface" }),
    );
  });

  it("errors when both --force and --if-match are provided", async () => {
    const writeSpy = vi.spyOn(mockClient, "writeFile");

    const { exitCode, stderr } = await runCommand(
      writeCommand,
      ["test.md"],
      { content: "# New", name: "Test", force: true, "if-match": "abc123" },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Use either --force or --if-match");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("surfaces conflict details when API returns structured 409", async () => {
    const conflict = new SdkError({
      message: "PUT /repos/repo_test/files/test.md: 409 — conflict",
      category: "client_error",
      status: 409,
      retryable: false,
    });
    (conflict as any).detail = {
      detail: {
        error: "conflict",
        path: "test.md",
        expected_sha: "abc123",
        actual_sha: "def456",
      },
    };

    vi.spyOn(mockClient, "writeFile").mockRejectedValue(conflict);

    const { exitCode, stderr } = await runCommand(
      writeCommand,
      ["test.md"],
      { content: "# New", name: "Test" },
    );

    expect(exitCode).toBe(5);
    expect(stderr).toContain("Write conflict");
    expect(stderr).toContain("Expected SHA: abc123");
    expect(stderr).toContain("Actual SHA:   def456");
  });

  it("errors without path", async () => {
    const { exitCode, stderr } = await runCommand(writeCommand);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});

// ─── awareness ─────────────────────────────────────────────────────

describe("awareness", () => {
  it("prints awareness block", async () => {
    const { exitCode, stdout } = await runCommand(awarenessCommand);
    expect(exitCode).toBe(0);
    // Awareness block comes from session.getAwarenessBlock() which calls navigate
    expect(stdout.length).toBeGreaterThan(0);
  });
});
