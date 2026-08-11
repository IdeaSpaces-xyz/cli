/**
 * `ideaspaces share` — give a Space to a person, and see who has it.
 *
 * The product verbs address a Content target by node id and speak in grades:
 * `invite` (explore | fork | collaborate), `people`, `unshare`. None of them
 * needs a `repo_id` — the target comes from the folder you are standing in.
 *
 * The repo-shaped subcommands (`access`, `set-access`, `members`, `remove`,
 * `invites`, `revoke`, `legacy-invite`) remain for repositories that still
 * carry roles and public-link policy. They are compatibility, not the path a
 * new invitation takes.
 *
 * All owner-gated on the backend (403 otherwise). `--json` everywhere.
 */

import {
  addPersonShare,
  describeShareRefusal,
  removePersonShare,
  revokePersonShareInvite,
  listPersonShares,
  listPersonShareInvites,
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
  type ShareGrade,
  type PersonShareAddResult,
} from "../auth/api.js";
import { loadConfig, type LoadedConfig } from "../auth/credentials.js";
import { resolveSpaceBinding } from "../auth/resolve-space.js";
import { repoRoot } from "../git.js";
import { parseSpaceLocator } from "../space-locator.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE =
  "ideaspaces share <invite|unshare|people|access|set-access|members|remove|invites|revoke|legacy-invite> …";

/**
 * The grades a Space is shared at. One per invitation, mutually exclusive.
 *
 *   explore      read it
 *   fork         read it and take an independent copy
 *   collaborate  read it and push back
 */
const GRADES: ShareGrade[] = ["explore", "fork", "collaborate"];

/**
 * Roles the compatibility path still accepts.
 *
 * `CLONER` is deliberately absent. "May copy" is now a grade on a target
 * (`--grade fork`), not a seat in a repository, and leaving the old word
 * reachable would keep two vocabularies alive for one capability. Naming it
 * still gets a pointer rather than a bare rejection — see below.
 */
const LEGACY_ROLES: InviteRole[] = ["MEMBER", "READER"];
const COPY_LEVELS: CopyAccessLevel[] = ["owner", "member", "reader", "public"];

/** The session, or null after saying so — the three product verbs have no
 * `repo_id` to hand to `setup()`, and were each repeating this. */
function requireConfig(output: Output) {
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return null;
  }
  return config;
}

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

/**
 * The Content target to share: an explicit Space URL, or the clone you are in.
 *
 * Resolution reuses the binding ladder, so a clone whose registry record
 * predates root node ids still resolves — from its own origin, or from the
 * account. Without that, "share what I am standing in" would work only for
 * clones made recently enough.
 */
async function resolveTarget(
  spaceUrl: string | undefined,
  config: LoadedConfig,
  output: Output,
): Promise<string | null> {
  if (spaceUrl) {
    try {
      return parseSpaceLocator(spaceUrl, config.apiUrl).rootNodeId;
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  let root: string;
  try {
    root = repoRoot();
  } catch {
    output.error(
      "Not inside a Space. Run this from a clone, or name one: --space <url>",
    );
    return null;
  }
  const binding = await resolveSpaceBinding(root, config);
  if ("rootNodeId" in binding) return binding.rootNodeId;
  output.error(
    binding.failure === "unreachable"
      ? "Could not reach your account to work out which Space this is. Retry when you're back online."
      : binding.failure === "ambiguous"
        ? "This clone's origin matches more than one of your Spaces. Name one: --space <url>"
        : "Could not tell which Space this clone belongs to. Name one: --space <url>",
  );
  return null;
}

/** What happened, in the words the person sharing needs. */
function describeShare(res: PersonShareAddResult): string {
  // Straight from username to the *invite's* email skipped the relationship's
  // own address, so anyone without a username became "them" — and
  // "them's account cannot receive access" with it.
  const who =
    res.relationship?.username ??
    res.relationship?.email ??
    res.pending_invite?.invited_email ??
    "them";
  const history = res.share_history ? ", with the trail" : "";
  // `where` is a route, not a URL — label it, or it reads as stray output.
  const where = res.recipient_route ? `\nThey reach it at ${res.recipient_route}` : "";
  switch (res.status) {
    case "added":
      return `Shared with ${who} at ${res.grade}${history}.${where}`;
    case "invited":
      return `No account yet — invited ${who} at ${res.grade}${history}.\nThey get access when they accept.`;
    case "already_pending":
      return `Already invited ${who}; that invitation still stands.`;
    case "already_direct":
      // Not an error, and not a no-op worth hiding: they hold this already, by
      // a relationship someone granted before.
      return `${who} already has direct access here. Nothing changed.`;
    case "self":
      return "That is your own address — you already have this Space.";
    case "no_match":
      return "No account matches, and no invitation was sent.";
    case "recipient_unavailable":
      return `${who}'s account cannot receive access right now.`;
    default:
      return `${res.status}: ${who}`;
  }
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
        // rest[0] is an email here, not a repo_id: the whole point of this
        // slice is that sharing what you are standing in needs no internal
        // repository identifier.
        const email = rest[0];
        const config = requireConfig(output);
        if (!config) return 1;
        if (email && !email.includes("@")) {
          // Order matters: `share invite notanemail extra@x.com` should say the
          // first argument is not an address, not lecture about the second.
          output.error(
            `Not an email address: ${email}\n` +
              "Usage: ideaspaces share invite <email> [--grade explore|fork|collaborate] [--history]",
          );
          return 1;
        }
        if (rest.length > 1) {
          // The old verb took a list. Dropping the extras silently would be the
          // exact surprise this command's own reporting exists to avoid.
          output.error(
            `Refused — one address per call, and nothing was sent. A grade is per person.\n` +
              `You named ${rest.length}: ${rest.join(", ")}\n` +
              "Run it once per person.",
          );
          return 1;
        }
        if (!email) {
          output.error(
            "Usage: ideaspaces share invite <email> [--grade explore|fork|collaborate] [--history]\n" +
              "Sharing a Space you are not standing in: --space <url>",
          );
          return 1;
        }
        const grade = (flagStr(flags, "grade") ?? "explore") as ShareGrade;
        if (!GRADES.includes(grade)) {
          output.error(`--grade must be one of: ${GRADES.join(", ")}`);
          return 1;
        }

        const target = await resolveTarget(flagStr(flags, "space"), config, output);
        if (!target) return 1;

        const res = await addPersonShare(config, target, {
          email,
          invite_if_no_match: true,
          grade,
          share_history: Boolean(flags.history),
        });
        output.result(res, describeShare(res));
        return 0;
      }
      case "people": {
        const config = requireConfig(output);
        if (!config) return 1;
        const target = await resolveTarget(flagStr(flags, "space"), config, output);
        if (!target) return 1;

        // Both halves, because "who has this" is not answered by either alone:
        // a relationship is someone who accepted, an invite is someone who has
        // not yet.
        // Settled separately: the two answer different halves, and one failing
        // must not make the other's half look complete.
        const [peopleSettled, pendingSettled] = await Promise.allSettled([
          listPersonShares(config, target),
          listPersonShareInvites(config, target),
        ]);
        if (peopleSettled.status === "rejected") throw peopleSettled.reason;
        const people = peopleSettled.value;
        const pending =
          pendingSettled.status === "fulfilled" ? pendingSettled.value : { invites: [] };
        const invitesUnread =
          pendingSettled.status === "rejected"
            ? pendingSettled.reason instanceof Error
              ? pendingSettled.reason.message
              : String(pendingSettled.reason)
            : null;
        const lines = [
          ...people.relationships.map(
            (r) =>
              `  ${(r.username ?? r.email ?? `user ${r.user_id}`).padEnd(24)} ${r.access}` +
              `${r.share_history ? " + history" : ""}`,
          ),
          ...pending.invites.map((i) => `  ${i.invited_email.padEnd(24)} invited (${i.grade})`),
        ];
        if (!people.actions.can_add && people.actions.add_blocked_reason) {
          lines.push("", `You cannot add people here: ${people.actions.add_blocked_reason}`);
        }
        if (invitesUnread) {
          // An empty invite list and an unread one look identical otherwise —
          // and a scripted caller would read the first as ground truth.
          lines.push("", `Outstanding invitations could not be read: ${invitesUnread}`);
        }
        output.result(
          { ...people, pending_invites: pending.invites, invites_unavailable: invitesUnread },
          lines.length ? lines.join("\n") : "nobody has direct access",
        );
        return 0;
      }
      case "unshare": {
        // The undo for `invite`. It takes the same thing `invite` took — an
        // address — because the person undoing knows who they shared with, not
        // whether that person ever accepted. Which of the two it is decides the
        // endpoint, so resolve it here rather than making the user know.
        const who = rest[0];
        const config = requireConfig(output);
        if (!config) return 1;
        if (!who) {
          output.error("Usage: ideaspaces share unshare <email|username> [--space <url>]");
          return 1;
        }
        const target = await resolveTarget(flagStr(flags, "space"), config, output);
        if (!target) return 1;

        const needle = who.toLowerCase();
        // Both, together: an address is either an accepted relationship or an
        // outstanding invitation, and asking sequentially made the invitation
        // case — the likelier one to undo — pay for two round trips.
        const [people, pending] = await Promise.all([
          listPersonShares(config, target),
          listPersonShareInvites(config, target),
        ]);
        const held = people.relationships.find(
          (r) => r.email?.toLowerCase() === needle || r.username?.toLowerCase() === needle,
        );
        if (held) {
          await removePersonShare(config, target, held.user_id);
          output.result(
            { removed: { user_id: held.user_id, username: held.username ?? null }, target_node_id: target },
            `Removed ${held.username ?? held.email ?? held.user_id}'s access.`,
          );
          return 0;
        }

        const invite = pending.invites.find((i) => i.invited_email.toLowerCase() === needle);
        if (invite) {
          await revokePersonShareInvite(config, target, invite.invite_id);
          output.result(
            { revoked: invite.invite_id, invited_email: invite.invited_email, target_node_id: target },
            `Withdrew the invitation to ${invite.invited_email}.`,
          );
          return 0;
        }

        // Saying "nothing to undo" is different from saying "done" — the
        // address may be mistyped, and access they hold some other way is not
        // ours to remove here.
        output.error(
          `${who} holds no direct access here and has no invitation outstanding.\n` +
            "See who does: ideaspaces share people",
        );
        return 1;
      }
      case "legacy-invite": {
        const config = setup(repoId, "ideaspaces share legacy-invite <repo_id> <email…> --role <role>", output);
        if (!config) return 1;
        const emails = rest.slice(1).filter(Boolean);
        const role = (flagStr(flags, "role") ?? "READER") as InviteRole;
        if (!emails.length) {
          output.error("Usage: ideaspaces share legacy-invite <repo_id> <email…> --role <role>");
          return 1;
        }
        if (String(role).toUpperCase() === "CLONER") {
          // The one role with a direct replacement, so say the replacement
          // rather than only refusing the word.
          output.error(
            "CLONER is gone. Copying is a grade on the Space now:\n" +
              "  ideaspaces share invite <email> --grade fork",
          );
          return 1;
        }
        if (!LEGACY_ROLES.includes(role)) {
          output.error(`--role must be one of: ${LEGACY_ROLES.join(", ")}`);
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
    output.error(describeShareRefusal(err) ?? (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

export const shareCommand: CommandDef = {
  name: "share",
  description: "Share a Space with someone, and manage who has it",
  usage: USAGE,
  examples: [
    "ideaspaces share invite someone@example.com",
    "ideaspaces share invite someone@example.com --grade fork",
    "ideaspaces share invite someone@example.com --grade collaborate --history",
    "ideaspaces share unshare someone@example.com",
    "ideaspaces share people --json",
    "ideaspaces share legacy-invite repo_abc a@x.com --role MEMBER",
    "ideaspaces share access repo_abc --json",
    "ideaspaces share set-access repo_abc --public true --copy reader",
    "ideaspaces share members repo_abc --json",
    "ideaspaces share invites repo_abc",
    "ideaspaces share revoke repo_abc inv_123",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    return run(sub ?? "", rest, flags, output);
  },
};
