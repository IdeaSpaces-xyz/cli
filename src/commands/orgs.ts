/**
 * `ideaspaces orgs members <hostname>`: who is in an organization, so whoever
 * shares can tell a person is in the team, and under which @handle, before
 * sharing with them or with the whole team.
 *
 * The service answers an organization's owner only, and gives a member's email
 * only when it is on the organization's own hostname. `--json` is its answer,
 * unchanged.
 */

import {
  ApiStatusError,
  apiErrorDetail,
  listOrgMembers,
  UnauthorizedError,
  type OrgMember,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

const USAGE = "ideaspaces orgs members <hostname> [--json]";
const ORG_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** `acme.com` or `hostname:acme.com`, the address the other verbs use. */
function orgHostname(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase().replace(/^hostname:/, "");
  return host && ORG_HOSTNAME.test(host) ? host : null;
}

function memberLine(member: OrgMember): string {
  const who = member.username ? `@${member.username}` : "(no handle yet)";
  const role = member.org_role ?? "no role";
  const status = member.status && member.status !== "active" ? ` · ${member.status}` : "";
  return `  ${who.padEnd(24)} ${(member.email ?? "").padEnd(32)} ${role}${status}`.replace(/\s+$/, "");
}

async function members(rest: string[], output: Output): Promise<number> {
  const hostname = orgHostname(rest[0]);
  if (!hostname || rest.length !== 1) {
    output.error(rest[0] && rest.length === 1 ? `Expected an organization's hostname, like acme.com, got: ${rest[0]}` : `Usage: ${USAGE}`);
    return 1;
  }
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }
  try {
    const result = await listOrgMembers(config, hostname);
    const list = Array.isArray(result?.members) ? result.members : [];
    const active = list.filter((member) => !member.status || member.status === "active");
    const others = list.filter((member) => member.status && member.status !== "active");
    const lines = [
      `${result.hostname ?? hostname}: ${active.length} member${active.length === 1 ? "" : "s"}`,
      ...[...active, ...others].map(memberLine),
    ];
    if (active.some((member) => member.username)) {
      lines.push(
        "",
        `Share with one of them: ideaspaces share person @handle --grade explore|fork|collaborate`,
        `Share with all of them: ideaspaces share team ${hostname} --grade explore|fork|collaborate`,
      );
    }
    output.result(result, lines.join("\n"));
    return 0;
  } catch (err) {
    if (err instanceof UnauthorizedError || (err instanceof ApiStatusError && err.status === 401)) {
      output.error("Session expired. Run `ideaspaces login`.");
      return 1;
    }
    if (err instanceof ApiStatusError && err.status === 403) {
      output.error(
        `${apiErrorDetail(err)}\nOnly an owner of ${hostname} can list its members. ` +
          `To share with everyone in it without the list: ideaspaces share team ${hostname}`,
      );
      return 1;
    }
    output.error(apiErrorDetail(err));
    return 1;
  }
}

export const orgsCommand: CommandDef = {
  name: "orgs",
  description: "See who is in an organization you own (GET /orgs/{hostname}/members)",
  usage: USAGE,
  subcommands: {
    members: USAGE,
  },
  examples: [
    "ideaspaces orgs members acme.com",
    "ideaspaces orgs members hostname:acme.com --json  # the service's answer unchanged",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const unknown = Object.keys(flags)[0];
    if (unknown) {
      output.error(`Unknown flag for orgs: --${unknown}. Usage: ${USAGE}`);
      return 1;
    }
    const [sub, ...rest] = args;
    if (sub === "members") return members(rest, output);
    output.error(`Usage: ${USAGE}`);
    return 1;
  },
};
