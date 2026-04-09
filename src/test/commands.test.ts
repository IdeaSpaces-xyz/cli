import { describe, it, expect, vi, beforeEach } from "vitest";
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
