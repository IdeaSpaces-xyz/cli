import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Output } from "../output.js";
import { localConversationOps } from "../pi/local-conversation-ops.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ideaspaces-local-map-turn-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePi(root: string): string {
  const path = join(root, "fake-pi.mjs");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = args.indexOf("--append-system-prompt");
const orientation = index === -1 ? "" : (args[index + 1] ?? "");
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += String(chunk);
  while (buffered.includes("\\n")) {
    const split = buffered.indexOf("\\n");
    const line = buffered.slice(0, split);
    buffered = buffered.slice(split + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionName: "Map test" } }));
    }
    if (command.type === "prompt") {
      const complete = orientation.includes('kind=position root=0 position="reports/market.md" depth=full')
        && orientation.includes('kind=address address="https://example.com/source" depth=summary');
      const text = complete ? "position and address territory available" : "map orientation missing";
      console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "turn_start" }));
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }));
      console.log(JSON.stringify({ type: "agent_end" }));
    }
  }
});
`);
  chmodSync(path, 0o755);
  return path;
}

const MAP_NOTE = `---
name: Research territory
summary: Two kinds of territory.
map:
  roots:
    - space: git.example.com/Acme/research
      sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  members:
    - space: 0
      position: reports/market.md
      depth: full
    - address: https://example.com/source
      depth: summary
---
Map legend.
`;

describe("conversation send --local --map", () => {
  it("refuses a missing map-note value before spawning Pi", async () => {
    const errors: string[] = [];
    const output: Output = {
      result() {},
      log() {},
      progress() {},
      error(text) { errors.push(text); },
    };

    const code = await localConversationOps.send(
      {
        message: "What territory is available?",
        ext: "/fake/pi-is-space,/fake/pi-local-context",
        map: true,
        "pi-bin": "/does/not/exist",
      },
      output,
    );

    expect(code).toBe(1);
    expect(errors).toEqual(["A map-note path is required: --map <file.md>"]);
  });

  it.skipIf(process.platform === "win32")(
    "places the validated Map in Pi's first-turn orientation without any root checkout",
    async () => {
      const root = workspace();
      writeFileSync(join(root, "territory.md"), MAP_NOTE);
      const piBin = fakePi(root);
      let stdout = "";
      const originalWrite = process.stdout.write;
      (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk) => {
        stdout += String(chunk);
        return true;
      };
      const errors: string[] = [];
      const output: Output = {
        result() {},
        log() {},
        progress() {},
        error(text) {
          errors.push(text);
        },
      };

      try {
        const code = await localConversationOps.send(
          {
            message: "What territory is available?",
            context: root,
            conversation: "local-map-test",
            ext: "/fake/pi-is-space,/fake/pi-local-context",
            map: "territory.md",
            "pi-bin": piBin,
          },
          output,
        );
        expect(code).toBe(0);
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(errors).toEqual([]);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toContainEqual({ type: "text_delta", delta: "position and address territory available" });
      expect(events.some((event) => event.type === "turn_complete")).toBe(true);
    },
  );
});
