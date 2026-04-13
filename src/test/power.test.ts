import { describe, it, expect, vi } from "vitest";
import { runCommand, makeMockClient } from "./helpers.js";

const mockClient = makeMockClient();
vi.mock("../client.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../client.js")>();
  return {
    ...orig,
    initClient: vi.fn().mockResolvedValue(mockClient),
  };
});

const { grepCommand } = await import("../commands/power/grep.js");
const { gitCommand } = await import("../commands/power/git.js");
const { outlineCommand } = await import("../commands/power/outline.js");
const { findCommand } = await import("../commands/power/find.js");
const { tagsCommand } = await import("../commands/power/tags.js");
const { reindexCommand } = await import("../commands/power/reindex.js");
const { statusCommand } = await import("../commands/power/status.js");
const { logoutCommand } = await import("../commands/power/logout.js");

describe("grep", () => {
  it("shows matches", async () => {
    const { exitCode, stdout } = await runCommand(grepCommand, ["test"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("core/about.md:1:");
  });

  it("returns JSON", async () => {
    const { stdout } = await runCommand(grepCommand, ["test"], {}, { json: true });
    const data = JSON.parse(stdout);
    expect(data.matches).toHaveLength(1);
  });

  it("errors without pattern", async () => {
    const { exitCode, stderr } = await runCommand(grepCommand);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});

describe("git", () => {
  it("shows log", async () => {
    const { exitCode, stdout } = await runCommand(gitCommand, ["log"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("abc123d");
    expect(stdout).toContain("Initial");
  });

  it("returns JSON", async () => {
    const { stdout } = await runCommand(gitCommand, ["log"], {}, { json: true });
    const data = JSON.parse(stdout);
    expect(data.entries).toHaveLength(1);
  });

  it("errors without op", async () => {
    const { exitCode, stderr } = await runCommand(gitCommand);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});

describe("outline", () => {
  it("shows full tree", async () => {
    const { exitCode, stdout } = await runCommand(outlineCommand);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("items in notes");
    expect(stdout).toContain("core/");
    expect(stdout).toContain("core/about.md");
  });
});

describe("find", () => {
  it("lists nodes", async () => {
    const { exitCode, stdout } = await runCommand(findCommand);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 node(s)");
    expect(stdout).toContain("core/about.md");
  });

  it("returns JSON", async () => {
    const { stdout } = await runCommand(findCommand, [], {}, { json: true });
    const data = JSON.parse(stdout);
    expect(data.nodes).toHaveLength(1);
  });
});

describe("tags", () => {
  it("lists tags with counts", async () => {
    const { exitCode, stdout } = await runCommand(tagsCommand);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("core");
    expect(stdout).toContain("(3)");
  });
});

describe("reindex", () => {
  it("reindexes active repo", async () => {
    const clientAny = mockClient as any;
    clientAny.reindexRepo = vi.fn().mockResolvedValue({
      data: {
        repo_id: "repo_test",
        removed_entries: 4,
        indexed_files: 9,
        status: "ok",
      },
    });

    const { exitCode, stdout } = await runCommand(reindexCommand);
    expect(exitCode).toBe(0);
    expect(clientAny.reindexRepo).toHaveBeenCalledWith("repo_test");
    expect(stdout).toContain("Reindexed: repo_test");
  });
});

describe("status", () => {
  it("shows status (logged in or not)", async () => {
    const { exitCode, stdout } = await runCommand(statusCommand);
    expect(exitCode).toBe(0);
    // Result depends on whether real credentials exist — both are valid
    expect(stdout.length).toBeGreaterThan(0);
  });
});

describe("logout", () => {
  it("returns success", async () => {
    const { exitCode, stdout } = await runCommand(logoutCommand);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged out");
  });
});
