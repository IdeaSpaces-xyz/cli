// The Pi connector — the CLI's local-agent surface, walled off from the core.
//
// Boundary rule: files under `src/commands/` (the universal CLI) MUST NOT import
// from `src/pi/`. Only the composition root (`src/router.ts`) wires the two —
// it injects `localConversationOps` into the core conversation commands and
// registers the Pi-runtime commands. This keeps `@ideaspaces/cli`'s core lean
// and Pi-free, so the connector can be sectioned (or later extracted) cleanly.
// The rule is enforced by `src/test/pi-boundary.test.ts` (the CLI has no ESLint),
// which fails if any `src/commands/**` file imports `src/pi/**`.

export { piStatusCommand } from "./pi-status.js";
export { piLoginCommand } from "./pi-login.js";
export { piLogoutCommand } from "./pi-logout.js";
export { piModelsCommand } from "./pi-models.js";
export { localConversationOps } from "./local-conversation-ops.js";
