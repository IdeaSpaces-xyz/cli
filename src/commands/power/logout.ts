import { deleteCredentials } from "../../auth/credentials.js";
import { clearSessionState } from "../../auth/session-state.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const logoutCommand: CommandDef = {
  name: "logout",
  description: "Log out and clear stored credentials",
  usage: "ideaspaces power logout",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    deleteCredentials();
    clearSessionState();
    output.result({ logged_out: true }, "Logged out. Credentials and session state removed.");
    return 0;
  },
};
