import type { Output } from "./output.js";
import { HostAuthRefusal } from "./auth/credentials.js";
import { HostTokenError } from "./auth/host-token.js";
import { HOST_TOKEN_COMMANDS } from "./host-token-flag.js";

/** What `main` knows about the failed command, so a hosted verb can answer in its own JSON. */
export interface ErrorContext {
  json?: boolean;
  command?: string;
}

export function handleError(err: unknown, output: Output, context: ErrorContext = {}): number {
  if (err instanceof HostAuthRefusal || err instanceof HostTokenError) {
    // A host app parses stdout: the hosted verbs answer this refusal in the same envelope as
    // every other hosted failure. There is no usable sign-in for this call.
    if (context.json && context.command && HOST_TOKEN_COMMANDS.has(context.command)) {
      process.stdout.write(JSON.stringify({ schema: "ideaspaces.hosted.error.v1", error: { state: "signed_out", message: err.message } }, null, 2) + "\n");
    }
    output.error(err instanceof HostAuthRefusal ? err.message : `Error: ${err.message}`);
    return 1;
  }
  if (err instanceof Error) {
    if (err.message.includes("Not logged in")) {
      output.error(`Error: ${err.message}\nRun: ideaspaces login`);
      return 2;
    }
    output.error(`Error: ${err.message}`);
    return 1;
  }

  output.error(`Error: ${String(err)}`);
  return 1;
}
