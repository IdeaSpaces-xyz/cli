import {
  apiErrorDetail,
  approveAccessRequest,
  cancelAccessRequest,
  createAccessRequest,
  denyAccessRequest,
  listAccessRequests,
  listIncomingAccessRequests,
  UnauthorizedError,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import { parseShareGrade, SHARE_GRADE_HELP, type ShareGradeWord } from "../share-grades.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

export const REQUEST_USAGE =
  "ideaspaces request <ask|list|approve|deny|cancel> ...\n" +
  "       ideaspaces request <node_id> [--grade explore|fork|collaborate] [--reason 'why']\n" +
  "       ideaspaces request list [--incoming|--mine]\n" +
  "       ideaspaces request approve <request_id> [--grade explore|fork|collaborate]\n" +
  "       ideaspaces request deny <request_id>  # or decline\n" +
  "       ideaspaces request cancel <request_id>";

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The same three grades `share` takes; the request verb's older words still work. */
export function parseGrade(grade?: string): ShareGradeWord | null {
  return grade ? parseShareGrade(grade) : "explore";
}

const INVALID_GRADE =
  "Invalid --grade: must be explore, fork or collaborate (the older viewer, copying and editor still work).";

async function runAuthenticated(
  output: Output,
  operation: (config: NonNullable<ReturnType<typeof loadConfig>>) => Promise<number>,
): Promise<number> {
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }
  try {
    return await operation(config);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      output.error("Session expired. Run `ideaspaces login`.");
      return 1;
    }
    output.error(apiErrorDetail(err));
    return 1;
  }
}

async function ask(target: string, flags: Flags, output: Output): Promise<number> {
  if (!target || !NODE_ID.test(target)) {
    output.error(`Invalid target Node ID "${target ?? ""}". Expected n_… identifier.`);
    return 1;
  }
  const gradeStr = flagString(flags, "grade");
  const grade = parseGrade(gradeStr);
  if (!grade) {
    output.error(INVALID_GRADE);
    return 1;
  }
  const reason = flagString(flags, "reason");

  return runAuthenticated(output, async (config) => {
    const result = await createAccessRequest(config, target, { grade, reason });
    const gradeLabel = result.requested_grade;
    const text = `Requested ${gradeLabel} access to ${result.target_node_id} (request ${result.id}). The owner will decide.`;
    output.result(result, text);
    return 0;
  });
}

async function list(args: string[], flags: Flags, output: Output): Promise<number> {
  const mine = flags.mine === true || flags.own === true;
  return runAuthenticated(output, async (config) => {
    if (mine) {
      const response = await listAccessRequests(config, { includeTerminal: flags["include-terminal"] === true });
      const requests = response.requests;
      if (!requests.length) {
        output.result({ requests }, "No access requests found.");
        return 0;
      }
      const lines = [`Your access requests (${requests.length}):`, ""];
      for (const req of requests) {
        lines.push(
          `${req.id}  Access request for ${req.target_node_id}`,
          `  Requested: ${req.requested_grade} · State: ${req.state}`,
        );
        if (req.reason) lines.push(`  Reason: ${req.reason}`);
        lines.push("");
      }
      output.result({ requests }, lines.join("\n").trimEnd());
      return 0;
    }

    const response = await listIncomingAccessRequests(config);
    const requests = response.requests;
    if (!requests.length) {
      output.result({ requests }, "No incoming access requests.");
      return 0;
    }
    const lines = [`Incoming access requests (${requests.length}):`, ""];
    for (const req of requests) {
      lines.push(
        `${req.id}  Access request for ${req.target_node_id}`,
        `  ${req.requester} requests ${req.requested_grade}`,
      );
      if (req.reason) lines.push(`  Reason: ${req.reason}`);
      lines.push("");
    }
    output.result({ requests }, lines.join("\n").trimEnd());
    return 0;
  });
}

async function approve(requestId: string, flags: Flags, output: Output): Promise<number> {
  if (!requestId) {
    output.error("Usage: ideaspaces request approve <request_id> [--grade <grade>]");
    return 1;
  }
  const gradeStr = flagString(flags, "grade");
  const parsed = gradeStr ? parseGrade(gradeStr) : undefined;
  if (gradeStr && !parsed) {
    output.error(INVALID_GRADE);
    return 1;
  }
  const grade = parsed ?? undefined;

  return runAuthenticated(output, async (config) => {
    const result = await approveAccessRequest(config, requestId, { grade });
    const gradeLabel = result.approved_grade ?? result.requested_grade;
    const text = `Approved ${gradeLabel} access for request ${result.id} (${result.target_node_id}).`;
    output.result(result, text);
    return 0;
  });
}

async function deny(requestId: string, output: Output): Promise<number> {
  if (!requestId) {
    output.error("Usage: ideaspaces request deny <request_id>");
    return 1;
  }

  return runAuthenticated(output, async (config) => {
    const result = await denyAccessRequest(config, requestId);
    const text = `Declined request ${result.id} for ${result.target_node_id}.`;
    output.result(result, text);
    return 0;
  });
}

async function cancel(requestId: string, output: Output): Promise<number> {
  if (!requestId) {
    output.error("Usage: ideaspaces request cancel <request_id>");
    return 1;
  }

  return runAuthenticated(output, async (config) => {
    const result = await cancelAccessRequest(config, requestId);
    const text = `Cancelled request ${result.id}.`;
    output.result(result, text);
    return 0;
  });
}

export const requestCommand: CommandDef = {
  name: "request",
  description: "Ask for access to shared Content, and list, approve or decline requests",
  usage: REQUEST_USAGE,
  help: SHARE_GRADE_HELP,
  subcommands: {
    ask: "ideaspaces request ask <node_id> [--grade explore|fork|collaborate] [--reason <text>]",
    list: "ideaspaces request list [--incoming|--mine]",
    incoming: "ideaspaces request incoming",
    approve: "ideaspaces request approve <request_id> [--grade explore|fork|collaborate]",
    deny: "ideaspaces request deny <request_id>",
    decline: "ideaspaces request decline <request_id>",
    cancel: "ideaspaces request cancel <request_id>",
  },
  helpArgument: (word) => /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/.test(word),
  examples: [
    "ideaspaces request n_0123456789abcdef01234567 --grade explore --reason 'Need to review finding'",
    "ideaspaces request list",
    "ideaspaces request list --mine",
    "ideaspaces request approve r_0123456789abcdef01",
    "ideaspaces request approve r_0123456789abcdef01 --grade collaborate",
    "ideaspaces request decline r_0123456789abcdef01",
    "ideaspaces request cancel r_0123456789abcdef01",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;

    if (!sub) {
      output.error(`Usage: ${REQUEST_USAGE}`);
      return 1;
    }

    if (sub === "list" || sub === "incoming") {
      return list(rest, flags, output);
    }
    if (sub === "approve") {
      return approve(rest[0], flags, output);
    }
    if (sub === "deny" || sub === "decline") {
      return deny(rest[0], output);
    }
    if (sub === "cancel") {
      return cancel(rest[0], output);
    }
    if (sub === "ask") {
      return ask(rest[0], flags, output);
    }
    return ask(sub, flags, output);
  },
};
