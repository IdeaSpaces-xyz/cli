/**
 * Test helpers — capture output, mock client initialization.
 */

import { vi } from "vitest";
import { createClient, createMockTransport, type IsClient } from "@ideaspaces/sdk";
import type { GlobalFlags } from "../types.js";

export interface CapturedOutput {
  stdout: string;
  stderr: string;
}

/**
 * Run a command's run() function, capturing stdout and stderr.
 */
export async function runCommand(
  command: { run: (args: string[], flags: Record<string, string | boolean>, global: GlobalFlags) => Promise<number> },
  args: string[] = [],
  flags: Record<string, string | boolean> = {},
  globalOverrides: Partial<GlobalFlags> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const global: GlobalFlags = {
    json: false,
    quiet: false,
    yes: false,
    help: false,
    ...globalOverrides,
  };

  let stdout = "";
  let stderr = "";

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await command.run(args, flags, global);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

/** Standard mock routes for a connected client. */
export const MOCK_ROUTES = {
  "GET /repos": {
    repos: [
      { repo_id: "repo_test", slug: "notes", hostname: null, role: "OWNER", name: "My Notes", file_count: 10, last_activity: "2026-04-09" },
    ],
  },
  "GET /repos/repo_test/tree": {
    path: "",
    readme: "# My Space",
    now: "Building CLI",
    children: [
      { name: "core", type: "directory", file_count: 5, summary: "Core concepts" },
      { name: "about.md", type: "file", summary: "About this space" },
    ],
    ancestor_context: [],
    agent_context: [
      { kind: "now", name: "now", path: "_agent/now.md" },
      { kind: "purpose", name: "purpose", path: "_agent/purpose.md" },
    ],
    conversations: [],
    centroid: null,
    file_count: 10,
  },
  "GET /search": {
    results: [
      { node_id: "n_abc", path: "core/about.md", name: "About", summary: "About the space", score: 0.95, tags: [], attached_to: [], node_type: "note" },
    ],
  },
  "GET /repos/repo_test/files/core%2Fabout.md": {
    path: "core/about.md",
    node_id: "n_abc",
    content: "# About\n\nThis is the about page.",
    total_lines: 3,
    frontmatter: { name: "About" },
    node_type: "note",
    tags: ["core"],
    attached_to: [],
    last_commit_sha: "abc123",
  },
  "PUT /repos/repo_test/files/test.md": {
    path: "test.md",
    node_id: "n_new",
    commit_sha: "def456",
  },
  "GET /repos/repo_test/git": {
    op: "log",
    entries: [{ sha: "abc123def", message: "Initial", date: "2026-04-09", author: "user" }],
  },
  "GET /repos/repo_test/nodes/outline": {
    repo_id: "repo_test",
    username: "user",
    slug: "notes",
    items: [
      { type: "branch", path: "core", summary: "Core concepts" },
      { type: "note", path: "core/about.md", name: "About", summary: "About the space" },
    ],
  },
  "GET /repos/repo_test/grep": {
    pattern: "test",
    matches: [{ file: "core/about.md", line_number: 1, content: "# About" }],
  },
  "GET /repos/repo_test/tags": {
    tags: [{ tag: "core", total: 3, notes: 3, perspectives: 0 }],
  },
  "GET /repos/repo_test/nodes": {
    nodes: [
      { node_id: "n_abc", name: "About", summary: "About the space", node_type: "note", path: "core/about.md", tags: ["core"], attached_to: [] },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  },
  "POST /repos/repo_test/reindex": {
    repo_id: "repo_test",
    removed_entries: 4,
    indexed_files: 9,
    status: "ok",
  },
  "POST /repos/connect": {
    repo_id: "repo_connected",
    slug: "ideaspace",
    name: "IdeaSpace",
  },
};

/**
 * Create a mock client with standard routes.
 * Use `vi.mock` to replace initClient before importing commands.
 */
export function makeMockClient(extraRoutes: Record<string, unknown> = {}): IsClient {
  const client = createClient({
    transport: createMockTransport({ ...MOCK_ROUTES, ...extraRoutes }),
    repo: "repo_test",
    apiKey: "test",
  });
  return client;
}
