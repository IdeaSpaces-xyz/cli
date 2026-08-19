/**
 * `ideaspaces share` — manage who can use a Space and whether it is public.
 *
 * The product surface is recipient-shaped: `person`, `team`, `list`, `remove`,
 * and `visibility`. People and teams receive one exact explore/fork/collaborate
 * grade; public visibility means anonymous view plus authenticated independent
 * copy, never Git history, clone, or push. Internal user, organization, Grant,
 * and repository ids stay behind the command.
 *
 * The older `invite`, `people`, and `unshare` words remain as aliases. Repo-
 * shaped access/member/invite commands remain compatibility paths for old
 * repositories, not the surface new help teaches.
 *
 * All owner-gated on the backend (403 otherwise). `--json` everywhere.
 */

import {
  addPersonShare,
  describeShareRefusal,
  fetchAuthMe,
  removePersonShare,
  revokePersonShareInvite,
  listPersonShares,
  listPersonShareInvites,
  listEligibleTeamAudiences,
  listTeamShares,
  setTeamShare,
  removeTeamShare,
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
  type ShareCapability,
  type PersonShareAddResult,
  type PersonShareStanding,
  type TeamShareRelationship,
} from "../auth/api.js";
import { loadConfig, type LoadedConfig } from "../auth/credentials.js";
import { resolveSpaceBinding } from "../auth/resolve-space.js";
import { repoRoot } from "../git.js";
import { parseSpaceLocator } from "../space-locator.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE =
  "ideaspaces share <person|team|list|remove|visibility> …";

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

function parseGrade(flags: Flags, output: Output): ShareGrade | null {
  const grade = (flagStr(flags, "grade")?.toLowerCase() ?? "explore") as ShareGrade;
  if (!GRADES.includes(grade)) {
    output.error(`--grade must be one of: ${GRADES.join(", ")}`);
    return null;
  }
  return grade;
}

function personSelector(value: string):
  | { username: string; invite_if_no_match: false }
  | { email: string; invite_if_no_match: true }
  | null {
  if (value.startsWith("@") && value.length > 1 && !value.slice(1).includes("@")) {
    return { username: value.slice(1), invite_if_no_match: false };
  }
  if (value.includes("@") && !value.startsWith("@")) {
    return { email: value, invite_if_no_match: true };
  }
  return null;
}

function recipientName(person: Pick<PersonShareStanding, "user_id" | "name" | "username" | "email">): string {
  return person.name ?? person.username ?? person.email ?? `user ${person.user_id}`;
}

/** Derive a product grade only from an exact direct bundle. */
function personStandingGrade(standing: PersonShareStanding): ShareGrade | null {
  const direct = new Set(standing.direct_capabilities);
  const hasContent = direct.has("read") || direct.has("write");
  const hasCopy = direct.has("space_copy");
  const hasFetch = direct.has("git_fetch");
  const hasPush = direct.has("git_push");
  if (hasContent && hasCopy && !hasFetch && !hasPush) return "fork";
  if (hasContent && !hasCopy && hasFetch && hasPush) return "collaborate";
  if (hasContent && !hasCopy && !hasFetch && !hasPush) return "explore";
  return null;
}

function capabilitySummary(capabilities: ShareCapability[]): string {
  const labels: Record<ShareCapability, string> = {
    read: "view",
    write: "edit",
    history: "history",
    space_copy: "fork",
    git_fetch: "clone",
    git_push: "push",
  };
  return capabilities.map((capability) => labels[capability]).join(", ");
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

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function repoIdForRoot(config: LoadedConfig, rootNodeId: string): Promise<string> {
  const me = await fetchAuthMe(config);
  const matches = me.repos.filter((repo) => repo.root_node_id === rootNodeId);
  if (matches.length === 1) return matches[0].repo_id;
  if (matches.length > 1) {
    throw new Error("This Space matches more than one managed repository. Re-link the clone before changing visibility.");
  }
  throw new Error("This Space is not in your managed repository catalog, so its visibility cannot be changed here.");
}

function describeTeamShareRefusal(err: unknown): string | null {
  const message = errorText(err);
  if (message.includes("active_team_membership_required")) {
    return "You must be an active member of that registered team to share with it.";
  }
  if (message.includes("git_authority_not_established")) {
    return "Collaborate is not available for this Space yet. Choose explore or fork.";
  }
  if (message.includes("root_governance_unestablished")) {
    return "Team sharing is not available for this Space yet.";
  }
  if (message.includes("organization_unregistered") || message.includes("organization_invalid")) {
    return "That team is not available for sharing.";
  }
  return null;
}

async function shareWithPerson(
  rest: string[],
  flags: Flags,
  output: Output,
): Promise<number> {
  const who = rest[0];
  if (!who || rest.length !== 1) {
    output.error(
      "Usage: ideaspaces share person <email|@handle> [--grade explore|fork|collaborate] [--history] [--space <url>]",
    );
    return 1;
  }
  const selector = personSelector(who);
  if (!selector) {
    output.error(`Expected an email address or @handle, got: ${who}`);
    return 1;
  }
  const grade = parseGrade(flags, output);
  if (!grade) return 1;
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(flagStr(flags, "space"), config, output);
  if (!target) return 1;
  const result = await addPersonShare(config, target, {
    ...selector,
    grade,
    share_history: Boolean(flags.history),
  });
  output.result(result, describeShare(result));
  return 0;
}

async function shareWithTeam(
  rest: string[],
  flags: Flags,
  output: Output,
): Promise<number> {
  const hostname = rest[0]?.replace(/^team:/i, "").toLowerCase();
  if (!hostname || rest.length !== 1) {
    output.error(
      "Usage: ideaspaces share team <hostname> [--grade explore|fork|collaborate] [--space <url>]",
    );
    return 1;
  }
  if (flags.history) {
    output.error("Hosted history is person-specific and cannot be attached to a team grade.");
    return 1;
  }
  const grade = parseGrade(flags, output);
  if (!grade) return 1;
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(flagStr(flags, "space"), config, output);
  if (!target) return 1;

  const audiences = await listEligibleTeamAudiences(config);
  const matches = audiences.filter((audience) => audience.hostname.toLowerCase() === hostname);
  if (matches.length !== 1) {
    const available = audiences.map((audience) => audience.hostname).sort();
    output.error(
      matches.length > 1
        ? `More than one registered team matches ${hostname}.`
        : `No registered team you belong to matches ${hostname}.` +
            (available.length ? `\nAvailable teams: ${available.join(", ")}` : ""),
    );
    return 1;
  }

  const result = await setTeamShare(config, target, matches[0].org_node_id, grade);
  const unchanged = result.status === "already_shared";
  output.result(
    result,
    unchanged
      ? `${hostname} already has ${grade} access.`
      : `${hostname}'s access is now ${grade}.`,
  );
  return 0;
}

async function listProductAccess(flags: Flags, output: Output): Promise<number> {
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(flagStr(flags, "space"), config, output);
  if (!target) return 1;

  const [peopleResult, invitesResult, teamsResult, visibilityResult] = await Promise.allSettled([
    listPersonShares(config, target),
    listPersonShareInvites(config, target),
    listTeamShares(config, target),
    repoIdForRoot(config, target).then((repoId) => getSpaceAccess(config, repoId)),
  ]);
  if (
    peopleResult.status === "rejected" &&
    teamsResult.status === "rejected" &&
    visibilityResult.status === "rejected"
  ) {
    throw peopleResult.reason;
  }

  const people = peopleResult.status === "fulfilled" ? peopleResult.value : null;
  const invites = invitesResult.status === "fulfilled" ? invitesResult.value.invites : [];
  const teams = teamsResult.status === "fulfilled" ? teamsResult.value : null;
  const visibility = visibilityResult.status === "fulfilled" ? visibilityResult.value : null;
  const unavailable = {
    people: peopleResult.status === "rejected" ? errorText(peopleResult.reason) : null,
    invitations: invitesResult.status === "rejected" ? errorText(invitesResult.reason) : null,
    teams: teamsResult.status === "rejected" ? errorText(teamsResult.reason) : null,
    visibility: visibilityResult.status === "rejected" ? errorText(visibilityResult.reason) : null,
  };

  const lines: string[] = ["Visibility"];
  if (!visibility) {
    lines.push("  unavailable");
  } else if (visibility.read_public && visibility.copy_access === "public") {
    lines.push("  public — anyone can view; signed-in people can fork");
  } else if (!visibility.read_public && visibility.copy_access === "owner") {
    lines.push("  private");
  } else {
    lines.push(
      `  custom compatibility policy — read ${visibility.read_public ? "public" : "private"}, copy ${visibility.copy_access}`,
    );
  }

  lines.push("", "People");
  const standings = people?.standings ?? [];
  if (!people) lines.push("  accepted access unavailable");
  for (const standing of standings) {
    const grade = personStandingGrade(standing);
    const history = standing.direct_capabilities.includes("history") ? " + history" : "";
    const direct = grade ?? (capabilitySummary(standing.direct_capabilities) || "no exact direct grade");
    const effectiveOnly = standing.effective_capabilities.filter(
      (capability) => !standing.direct_capabilities.includes(capability),
    );
    lines.push(
      `  ${recipientName(standing).padEnd(24)} ${direct}${history}` +
        (effectiveOnly.length ? `; also ${capabilitySummary(effectiveOnly)} through another path` : ""),
    );
  }
  for (const invite of invites) {
    lines.push(
      `  ${invite.invited_email.padEnd(24)} invited (${invite.grade}${invite.share_history ? " + history" : ""})`,
    );
  }
  if (invitesResult.status === "rejected") lines.push("  pending invitations unavailable");
  if (people && !standings.length && invitesResult.status === "fulfilled" && !invites.length) {
    lines.push("  none");
  }

  lines.push("", "Teams");
  if (!teams) {
    lines.push("  unavailable");
  } else if (!teams.relationships.length) {
    lines.push("  none");
  } else {
    for (const team of teams.relationships) {
      lines.push(
        `  ${(team.hostname ?? "unavailable team").padEnd(24)} ${team.grade ?? (team.direct_capabilities.join(", ") || "no exact grade")}`,
      );
    }
  }

  output.result(
    {
      target_node_id: target,
      visibility,
      people,
      pending_invites: invites,
      teams,
      unavailable,
    },
    lines.join("\n"),
  );
  return 0;
}

async function removeProductAccess(
  rest: string[],
  flags: Flags,
  output: Output,
): Promise<number> {
  const who = rest[0];
  if (!who || rest.length !== 1) {
    output.error("Usage: ideaspaces share remove <email|@handle|team:hostname> [--space <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(flagStr(flags, "space"), config, output);
  if (!target) return 1;

  if (who.toLowerCase().startsWith("team:")) {
    const hostname = who.slice(5).toLowerCase();
    const collection = await listTeamShares(config, target);
    const relationship = collection.relationships.find(
      (row) => row.hostname?.toLowerCase() === hostname,
    );
    if (!relationship) {
      output.error(`${hostname} has no direct team access here.`);
      return 1;
    }
    const result = await removeTeamShare(config, target, relationship.org_node_id);
    output.result(
      result,
      result.status === "removed"
        ? `Removed direct team access for ${hostname}. Members may still have access through another path.`
        : `Direct team access was already removed for ${hostname}.`,
    );
    return 0;
  }

  const selector = personSelector(who);
  if (!selector) {
    output.error(`Expected an email address, @handle, or team:hostname, got: ${who}`);
    return 1;
  }
  const [peopleResult, invitesResult] = await Promise.allSettled([
    listPersonShares(config, target),
    listPersonShareInvites(config, target),
  ]);
  if (peopleResult.status === "rejected") throw peopleResult.reason;
  const needle = ("username" in selector ? selector.username : selector.email).toLowerCase();
  const standing = peopleResult.value.standings.find((row) =>
    "username" in selector
      ? row.username?.toLowerCase() === needle
      : row.email?.toLowerCase() === needle,
  );
  if (standing) {
    const result = await removePersonShare(config, target, standing.user_id);
    const remains = result.effective_capabilities.length
      ? ` ${recipientName(standing)} still has ${capabilitySummary(result.effective_capabilities)} through another path.`
      : "";
    output.result(
      result,
      (result.status === "removed"
        ? `Removed direct access for ${recipientName(standing)}.`
        : `Direct access was already removed for ${recipientName(standing)}.`) + remains,
    );
    return 0;
  }

  const invites = invitesResult.status === "fulfilled" ? invitesResult.value.invites : [];
  const invite = "email" in selector
    ? invites.find((row) => row.invited_email.toLowerCase() === needle)
    : undefined;
  if (invite) {
    await revokePersonShareInvite(config, target, invite.invite_id);
    output.result(
      { revoked: invite.invite_id, invited_email: invite.invited_email, target_node_id: target },
      `Withdrew the invitation to ${invite.invited_email}.`,
    );
    return 0;
  }

  output.error(
    invitesResult.status === "rejected"
      ? `${who} has no direct accepted access here, and pending invitations could not be read (${errorText(invitesResult.reason)}).`
      : `${who} has no direct access or pending invitation here.`,
  );
  return 1;
}

async function setVisibility(rest: string[], flags: Flags, output: Output): Promise<number> {
  const requested = rest[0]?.toLowerCase();
  if ((requested !== "public" && requested !== "private") || rest.length !== 1) {
    output.error("Usage: ideaspaces share visibility <public|private> [--space <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(flagStr(flags, "space"), config, output);
  if (!target) return 1;
  const repoId = await repoIdForRoot(config, target);
  const result = await setSpaceAccess(config, repoId, {
    read_public: requested === "public",
    copy_access: requested === "public" ? "public" : "owner",
  });
  output.result(
    { ...result, visibility: requested },
    requested === "public"
      ? "Public — anyone can view; signed-in people can fork. Git history, clone, and push remain private."
      : "Private — public view and fork are off. Named people and team access are unchanged.",
  );
  return 0;
}

async function run(sub: string, rest: string[], flags: Flags, output: Output): Promise<number> {
  // Named for the repo-shaped subcommands, which is all that used them when
  // this dispatcher was written. The product verbs (`invite`, `people`,
  // `unshare`) take an address and read `rest[0]` directly.
  const [repoId, arg] = rest;
  try {
    switch (sub) {
      case "person":
        return await shareWithPerson(rest, flags, output);
      case "team":
        return await shareWithTeam(rest, flags, output);
      case "list":
        return await listProductAccess(flags, output);
      case "visibility":
        return await setVisibility(rest, flags, output);
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
        // Product form is recipient-shaped. Preserve the two-coordinate
        // repository-member form only as a compatibility path for old repos.
        if (!(rest.length === 2 && repoId?.startsWith("repo_"))) {
          return await removeProductAccess(rest, flags, output);
        }
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
        // Case-folded because a person typing `--grade Fork` means fork, and
        // the old `--role` being case-sensitive is not a reason to keep it so.
        const grade = (flagStr(flags, "grade")?.toLowerCase() ?? "explore") as ShareGrade;
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
        if (!people.actions.can_manage_existing && people.actions.manage_blocked_reason) {
          // Otherwise the first sign is a bare 403 from `unshare` — learning
          // what you may do by being refused is what this command exists to
          // replace.
          lines.push(`You cannot change who has it: ${people.actions.manage_blocked_reason}`);
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
        // Settled, not all: a caller may be allowed to see relationships and not
        // invitations. Failing the whole verb would stop them removing someone
        // they can see, for want of a list their intent never needed. `people`
        // already degrades this way; making these concurrent must not quietly
        // cost that.
        const [peopleSettled, pendingSettled] = await Promise.allSettled([
          listPersonShares(config, target),
          listPersonShareInvites(config, target),
        ]);
        if (peopleSettled.status === "rejected") throw peopleSettled.reason;
        const people = peopleSettled.value;
        const pending =
          pendingSettled.status === "fulfilled" ? pendingSettled.value : { invites: [] };
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
        // Only claim the second half if we were able to read it.
        output.error(
          pendingSettled.status === "rejected"
            ? `${who} holds no direct access here, and the invitation list could not be read ` +
                `(${pendingSettled.reason instanceof Error ? pendingSettled.reason.message : String(pendingSettled.reason)}).\n` +
                "There may be an invitation outstanding that this cannot see."
            : `${who} holds no direct access here and has no invitation outstanding.\n` +
                "See who does: ideaspaces share people",
        );
        return 1;
      }
      case "legacy-invite": {
        const config = setup(repoId, "ideaspaces share legacy-invite <repo_id> <email…> --role <role>", output);
        if (!config) return 1;
        const emails = rest.slice(1).filter(Boolean);
        // Read as a string first: `InviteRole` cannot spell CLONER, which is the
        // point — so the check for it has to happen before the narrowing.
        const roleInput = (flagStr(flags, "role") ?? "READER").toUpperCase();
        if (!emails.length) {
          output.error("Usage: ideaspaces share legacy-invite <repo_id> <email…> --role <role>");
          return 1;
        }
        if (roleInput === "CLONER") {
          // The one role with a direct replacement, so say the replacement
          // rather than only refusing the word.
          output.error(
            "CLONER is gone. Copying is a grade on the Space now:\n" +
              "  ideaspaces share invite <email> --grade fork",
          );
          return 1;
        }
        const role = roleInput as InviteRole;
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
    const teamOperation =
      sub === "team" || (sub === "remove" && rest[0]?.toLowerCase().startsWith("team:"));
    output.error(
      (teamOperation
        ? describeTeamShareRefusal(err) ?? describeShareRefusal(err)
        : describeShareRefusal(err) ?? describeTeamShareRefusal(err)) ??
        (err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }
}

export const shareCommand: CommandDef = {
  name: "share",
  description: "Manage people, teams, and public visibility for a Space",
  usage: USAGE,
  examples: [
    "ideaspaces share person someone@example.com --grade explore",
    "ideaspaces share person @someone --grade fork",
    "ideaspaces share person someone@example.com --grade collaborate --history",
    "ideaspaces share team acme.com --grade collaborate",
    "ideaspaces share list",
    "ideaspaces share remove someone@example.com",
    "ideaspaces share remove team:acme.com",
    "ideaspaces share visibility public",
    "ideaspaces share visibility private --space https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    return run(sub ?? "", rest, flags, output);
  },
};
