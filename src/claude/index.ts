// The Claude Code connector — the CLI's second local-agent surface, beside the
// Pi connector (src/pi/). Same boundary rule: files under `src/commands/` MUST
// NOT import from `src/claude/`; only the composition root (`src/router.ts`)
// wires it in, through the `--runtime` dispatcher in `src/local/runtime.ts`.
// Enforced by `src/test/pi-boundary.test.ts`.

export { claudeStatusCommand } from "./claude-status.js";
export { claudeConversationOps } from "./local-conversation-ops.js";
