import {
  acknowledgeSubscription,
  deleteSubscription,
  listSubscriptions,
  putSubscription,
  UnauthorizedError,
  type FollowSourceKind,
  type FollowSubscription,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;
type SourceName = "thread" | "node" | "repo";

const FOLLOW_USAGE =
  "ideaspaces follow <thread|node|repo> <id> [--ack <position>]";
const UNFOLLOW_USAGE = "ideaspaces unfollow <thread|node|repo> <id>";
const EXCHANGE_ID = /^x_[A-Za-z0-9_-]{1,62}$/;
const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

interface Source {
  name: SourceName;
  kind: FollowSourceKind;
  id: string;
}

function sourceFrom(args: string[], output: Output, usage: string): Source | null {
  const [rawName, rawId] = args;
  if (args.length !== 2 || !rawName || !rawId) {
    output.error(`Usage: ${usage}`);
    return null;
  }
  if (rawName !== "thread" && rawName !== "node" && rawName !== "repo") {
    output.error(`Source must be one of: thread, node, repo.\nUsage: ${usage}`);
    return null;
  }
  const pattern = rawName === "thread" ? EXCHANGE_ID : NODE_ID;
  if (!pattern.test(rawId)) {
    output.error(`Invalid ${rawName} id: ${rawId}`);
    return null;
  }
  return {
    name: rawName,
    kind: rawName === "thread" ? "exchange" : "node",
    id: rawId,
  };
}

function parsePosition(value: string | boolean | undefined, output: Output): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    output.error("--ack must be a non-negative integer position.");
    return null;
  }
  const position = Number(value);
  if (!Number.isSafeInteger(position)) {
    output.error("--ack must be a non-negative safe integer position.");
    return null;
  }
  return position;
}

function matchingFollow(rows: FollowSubscription[], source: Source): FollowSubscription | undefined {
  return rows.find((row) => row.source_kind === source.kind && row.source_id === source.id);
}

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
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function follow(args: string[], flags: Flags, output: Output): Promise<number> {
  const source = sourceFrom(args, output, FOLLOW_USAGE);
  if (!source) return 1;
  const position = parsePosition(flags.ack, output);
  if (position === null) return 1;

  return runAuthenticated(output, async (config) => {
    if (position === undefined) {
      const row = await putSubscription(
        config,
        source.kind === "exchange"
          ? { exchange_id: source.id }
          : { target_node_id: source.id },
      );
      output.result(row, `Following ${source.name} ${source.id} from position ${row.cursor}.`);
      return 0;
    }

    const row = matchingFollow(await listSubscriptions(config), source);
    if (!row) {
      output.error(`Not following ${source.name} ${source.id}. Follow it before acknowledging.`);
      return 1;
    }
    const acknowledged = await acknowledgeSubscription(config, row.id, position);
    output.result(
      acknowledged,
      `Acknowledged ${source.name} ${source.id} through position ${acknowledged.cursor}.`,
    );
    return 0;
  });
}

async function unfollow(args: string[], output: Output): Promise<number> {
  const source = sourceFrom(args, output, UNFOLLOW_USAGE);
  if (!source) return 1;
  return runAuthenticated(output, async (config) => {
    const row = matchingFollow(await listSubscriptions(config), source);
    if (!row) {
      output.error(`Not following ${source.name} ${source.id}.`);
      return 1;
    }
    await deleteSubscription(config, row.id);
    output.result(
      { removed: true, subscription: row },
      `Unfollowed ${source.name} ${source.id}.`,
    );
    return 0;
  });
}

export const followCommand: CommandDef = {
  name: "follow",
  description: "Follow a Thread, Node, or repository and acknowledge its cursor",
  usage: FOLLOW_USAGE,
  examples: [
    "ideaspaces follow thread x_example",
    "ideaspaces follow node n_0123456789abcdef01234567",
    "ideaspaces follow repo n_0123456789abcdef01234567",
    "ideaspaces follow thread x_example --ack 42",
  ],
  async run(args, flags, global: GlobalFlags) {
    return follow(args, flags, createOutput(global));
  },
};

export const unfollowCommand: CommandDef = {
  name: "unfollow",
  description: "Stop following a Thread, Node, or repository",
  usage: UNFOLLOW_USAGE,
  examples: [
    "ideaspaces unfollow thread x_example",
    "ideaspaces unfollow repo n_0123456789abcdef01234567",
  ],
  async run(args, _flags, global: GlobalFlags) {
    return unfollow(args, createOutput(global));
  },
};
