import { signOut } from "../../auth/client-session.js";
import { clearSessionState } from "../../auth/session-state.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const logoutCommand: CommandDef = {
  name: "logout",
  description: "Log out and clear stored credentials",
  usage: "ideaspaces power logout",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    try {
      await signOut();
      clearSessionState();
      const explicit = !!process.env.IS_API_KEY;
      output.result({ logged_out: true, ...(explicit ? { env_override_active: true } : {}) }, "Logged out. This install's session was revoked, if present; local credentials and session state removed. Existing API keys were only forgotten, not revoked." + (explicit ? " IS_API_KEY remains set; unset it to stop using that explicit credential." : ""));
      return 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The sign-out operation failed.";
      output.error(`Sign-out did not finish: ${detail} Local credentials are retained when remote revocation fails. Resolve the cause and retry \`ideaspaces power logout\`.`);
      return 1;
    }
  },
};
