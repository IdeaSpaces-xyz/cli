/**
 * `ideaspaces share` — repo access management: members, email invites, and the
 * public-link access policy. All owner-gated on the backend (403 otherwise).
 * `--json` everywhere for programmatic use.
 */

import {
  listRepoMembers,
  removeRepoMember,
  listRepoInvites,
  createRepoInvites,
  revokeRepoInvite,
  getSpaceAccess,
  setSpaceAccess,
  UnauthorizedError,
  type InviteRole,
  type CopyAccessLevel,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE = "ideaspaces share <access|set-access|members|remove|invites|invite|revoke> <repo_id> …";

const INVITE_ROLES: InviteRole[] = ["MEMBER", "CLONER", "READER"];
const COPY_LEVELS: CopyAccessLevel[] = ["owner", "member", "reader", "public"];

function flagStr(flags: Flags, key: string): string | undefined {
  return typeof flags[key] === "string" ? (flags[key] as string) : undefined;
}

// Shared preamble: repo_id present + logged in. Returns the config, or null
// after emitting the error (the caller returns 1).
function setup(repoId: string | undefined, usage: string, output: Output) {
  if (!repoId) {
    output.error(`Usage: ${usage}`);
    return null;
  }
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return null;
  }
  return config;
}

async function run(sub: string, rest: string[], flags: Flags, output: Output): Promise<number> {
  const [repoId, arg] = rest;
  try {
    switch (sub) {
      case "access": {
        const config = setup(repoId, "ideaspaces share access <repo_id>", output);
        if (!config) return 1;
        const a = await getSpaceAccess(config, repoId!);
        output.result(
          a,
          `read: ${a.read_public ? "public" : "private"}\ncopy: ${a.copy_access}\nroot: ${a.root_node_id}`,
        );
        return 0;
      }
      case "set-access": {
        const config = setup(repoId, "ideaspaces share set-access <repo_id> --public <bool> --copy <level>", output);
        if (!config) return 1;
        const publicRaw = flagStr(flags, "public") ?? (flags.public === true ? "true" : undefined);
        const copy = flagStr(flags, "copy") as CopyAccessLevel | undefined;
        if (publicRaw === undefined || !copy) {
          output.error("Both --public <bool> and --copy <level> are required.");
          return 1;
        }
        if (!COPY_LEVELS.includes(copy)) {
          output.error(`--copy must be one of: ${COPY_LEVELS.join(", ")}`);
          return 1;
        }
        const read_public = publicRaw === "true";
        const a = await setSpaceAccess(config, repoId!, { read_public, copy_access: copy });
        output.result(a, `read: ${a.read_public ? "public" : "private"}\ncopy: ${a.copy_access}`);
        return 0;
      }
      case "members": {
        const config = setup(repoId, "ideaspaces share members <repo_id>", output);
        if (!config) return 1;
        const members = await listRepoMembers(config, repoId!);
        const human = members.length
          ? members.map((m) => `${m.role.padEnd(7)} ${m.username ?? m.email ?? `user ${m.user_id}`}`).join("\n")
          : "no members";
        output.result({ members }, human);
        return 0;
      }
      case "remove": {
        const config = setup(repoId, "ideaspaces share remove <repo_id> <user_id>", output);
        if (!config) return 1;
        const userId = Number(arg);
        if (!arg || !Number.isInteger(userId)) {
          output.error("Usage: ideaspaces share remove <repo_id> <user_id>");
          return 1;
        }
        await removeRepoMember(config, repoId!, userId);
        output.result({ removed: userId }, `Removed user ${userId}`);
        return 0;
      }
      case "invites": {
        const config = setup(repoId, "ideaspaces share invites <repo_id>", output);
        if (!config) return 1;
        const invites = await listRepoInvites(config, repoId!);
        const human = invites.length
          ? invites.map((i) => `${i.role.padEnd(7)} ${i.invited_email}`).join("\n")
          : "no pending invites";
        output.result({ invites }, human);
        return 0;
      }
      case "invite": {
        const config = setup(repoId, "ideaspaces share invite <repo_id> <email…> --role <role>", output);
        if (!config) return 1;
        const emails = rest.slice(1).filter(Boolean);
        const role = (flagStr(flags, "role") ?? "READER") as InviteRole;
        if (!emails.length) {
          output.error("Usage: ideaspaces share invite <repo_id> <email…> --role <role>");
          return 1;
        }
        if (!INVITE_ROLES.includes(role)) {
          output.error(`--role must be one of: ${INVITE_ROLES.join(", ")}`);
          return 1;
        }
        const res = await createRepoInvites(config, repoId!, emails, role);
        const human = res.results.map((r) => `${r.status.padEnd(16)} ${r.email}`).join("\n");
        output.result(res, human);
        return 0;
      }
      case "revoke": {
        const config = setup(repoId, "ideaspaces share revoke <repo_id> <invite_id>", output);
        if (!config) return 1;
        if (!arg) {
          output.error("Usage: ideaspaces share revoke <repo_id> <invite_id>");
          return 1;
        }
        await revokeRepoInvite(config, repoId!, arg);
        output.result({ revoked: arg }, `Revoked invite ${arg}`);
        return 0;
      }
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      output.error("Session expired. Run `ideaspaces login`.");
      return 1;
    }
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export const shareCommand: CommandDef = {
  name: "share",
  description: "Manage repo access — members, invites, and the public-link policy",
  usage: USAGE,
  examples: [
    "ideaspaces share access repo_abc --json",
    "ideaspaces share set-access repo_abc --public true --copy reader",
    "ideaspaces share members repo_abc --json",
    "ideaspaces share invite repo_abc a@x.com b@x.com --role MEMBER",
    "ideaspaces share revoke repo_abc inv_123",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    return run(sub ?? "", rest, flags, output);
  },
};
