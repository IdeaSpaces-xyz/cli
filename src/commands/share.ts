/**
 * `ideaspaces share` — manage who can use a Space and whether it is public.
 *
 * The product surface is recipient-shaped: `person`, `team`, `list`, `remove`,
 * `resend`, `history`, and `visibility`. People and teams receive one exact explore/fork/collaborate
 * grade; public visibility means anonymous view plus bounded history-free local
 * Fork, never Git history, clone, push, or an anonymous hosted owner. Internal
 * user, organization, Grant, and repository ids stay behind the command.
 *
 * All owner-gated on the backend (403 otherwise). `--json` everywhere.
 */

import {
  addPersonShare,
  describeShareRefusal,
  fetchAuthMe,
  removePersonShare,
  revokePersonShareInvite,
  resendPersonShareInvite,
  setPersonShareHistory,
  listPersonShares,
  listPersonShareInvites,
  listEligibleTeamAudiences,
  listTeamShares,
  setTeamShare,
  removeTeamShare,
  getSpaceAccess,
  setSpaceAccess,
  UnauthorizedError,
  type ShareGrade,
  type ShareCapability,
  type PersonShareAddResult,
  type PersonShareStanding,
} from "../auth/api.js";
import { loadConfig, type LoadedConfig } from "../auth/credentials.js";
import { resolveSpaceBinding } from "../auth/resolve-space.js";
import { repoRoot } from "../git.js";
import { parseRepoLocator } from "../repo-locator.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE =
  "ideaspaces share <person|team|list|remove|resend|history|visibility> …";

/**
 * The grades a Space is shared at. One per invitation, mutually exclusive.
 *
 *   explore      read it
 *   fork         read it and take an independent copy
 *   collaborate  read it and push back
 */
const GRADES: ShareGrade[] = ["explore", "fork", "collaborate"];

/** The session, or null after saying so. Recipient-shaped verbs have no repo id. */
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

/** The repo to act on. `--space` is the pre-rename spelling, still accepted. */
function repoFlag(flags: Flags): string | undefined {
  return flagStr(flags, "repo") ?? flagStr(flags, "space");
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

function standingForSelector(
  standings: PersonShareStanding[],
  selector: Exclude<ReturnType<typeof personSelector>, null>,
): PersonShareStanding | undefined {
  const needle = ("username" in selector ? selector.username : selector.email).toLowerCase();
  return standings.find((standing) =>
    "username" in selector
      ? standing.username?.toLowerCase() === needle
      : standing.email?.toLowerCase() === needle,
  );
}

function rejectLegacyShare(sub: string, output: Output): number {
  const replacements: Record<string, string> = {
    access: "Use `ideaspaces share list` to inspect access.",
    "set-access": "Use `ideaspaces share visibility public|private`.",
    members: "Use `ideaspaces share list`.",
    invites: "Use `ideaspaces share list`.",
    "legacy-invite": "Use `ideaspaces share person <email> --grade explore|fork|collaborate`.",
    revoke: "Use `ideaspaces share remove <email>`.",
    invite: "Use `ideaspaces share person <email> --grade explore|fork|collaborate`.",
    people: "Use `ideaspaces share list`.",
    unshare: "Use `ideaspaces share remove <email|@handle|team:hostname>`.",
  };
  output.error(`The legacy \`share ${sub}\` command was removed. ${replacements[sub]}`);
  return 1;
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

function invitationDeliverySummary(invite: {
  delivery_status: "unknown" | "sending" | "sent" | "failed";
  delivery_error?: string | null;
  can_resend: boolean;
  resend_retry_after_seconds?: number | null;
}): string {
  if (invite.delivery_status === "sent") return "";
  if (invite.delivery_status === "sending") return "; delivery in progress";
  const state = invite.delivery_status === "failed"
    ? `; delivery failed${invite.delivery_error ? ` (${invite.delivery_error})` : ""}`
    : "; delivery status unknown";
  if (invite.can_resend) return `${state}; resend available`;
  const wait = invite.resend_retry_after_seconds;
  return wait && wait > 0 ? `${state}; resend in ${wait}s` : state;
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

/**
 * The Content target to share: an explicit repo URL, or the clone you are in.
 *
 * Resolution reuses the binding ladder, so a clone whose registry record
 * predates root node ids still resolves — from its own origin, or from the
 * account. Without that, "share what I am standing in" would work only for
 * clones made recently enough.
 */
async function resolveTarget(
  repoUrl: string | undefined,
  config: LoadedConfig,
  output: Output,
): Promise<string | null> {
  if (repoUrl) {
    try {
      return parseRepoLocator(repoUrl, config.apiUrl).rootNodeId;
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
      "Not inside a repository. Run this from a clone, or name one: --repo <url>",
    );
    return null;
  }
  const binding = await resolveSpaceBinding(root, config);
  if ("rootNodeId" in binding) return binding.rootNodeId;
  output.error(
    binding.failure === "unpublished"
      ? "This is an unpublished local fork. Publish it before sharing the destination Space."
      : binding.failure === "local-only"
        ? "This Space has local identity but no hosted destination. Publish it before sharing."
        : binding.failure === "identity-dirty"
        ? "The root identity declaration has an uncommitted change. Commit or restore the selected _agent entrypoint before sharing."
        : binding.failure === "identity-drift"
          ? "The contract entrypoint, canonical origin, and local registry disagree on Space identity. Refusing to choose one."
          : binding.failure === "identity-ambiguous"
            ? "The canonical origin and local registry name different Spaces. Repair the binding before sharing."
            : binding.failure === "identity-invalid"
              ? "Space identity evidence is invalid. Inspect the selected Agreement or Foundation before sharing."
              : binding.failure === "unreachable"
                ? "Could not reach your account to work out which Space this is. Retry when you're back online."
                : binding.failure === "ambiguous"
                  ? "This clone's origin matches more than one of your repositories. Name one: --repo <url>"
                  : "Could not tell which repository this clone belongs to. Name one: --repo <url>",
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
      "Usage: ideaspaces share person <email|@handle> [--grade explore|fork|collaborate] [--history] [--repo <url>]",
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
  const target = await resolveTarget(repoFlag(flags), config, output);
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
      "Usage: ideaspaces share team <hostname> [--grade explore|fork|collaborate] [--repo <url>]",
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
  const target = await resolveTarget(repoFlag(flags), config, output);
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

async function listProductAccess(rest: string[], flags: Flags, output: Output): Promise<number> {
  if (rest.length) {
    output.error("Usage: ideaspaces share list [--repo <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(repoFlag(flags), config, output);
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
    lines.push("  public — anyone can view and fork locally; publishing requires sign-in");
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
      `  ${invite.invited_email.padEnd(24)} invited (${invite.grade}${invite.share_history ? " + history" : ""})` +
        invitationDeliverySummary(invite),
    );
  }
  if (invitesResult.status === "rejected") lines.push("  pending invitations unavailable");
  if (people && !standings.length && invitesResult.status === "fulfilled" && !invites.length) {
    lines.push("  none");
  }
  if (people && !people.actions.can_add && people.actions.add_blocked_reason) {
    lines.push(`  You cannot add people here: ${people.actions.add_blocked_reason}`);
  }
  if (people && !people.actions.can_manage_existing && people.actions.manage_blocked_reason) {
    lines.push(`  You cannot change who has it: ${people.actions.manage_blocked_reason}`);
  }

  lines.push("", "Teams");
  if (!teams) {
    lines.push("  unavailable");
  } else if (!teams.relationships.length) {
    lines.push("  none");
  } else {
    for (const team of teams.relationships) {
      lines.push(
        `  ${(team.hostname ?? "unavailable team").padEnd(24)} ${team.grade ?? (capabilitySummary(team.direct_capabilities) || "no exact grade")}`,
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
    output.error("Usage: ideaspaces share remove <email|@handle|team:hostname> [--repo <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(repoFlag(flags), config, output);
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
  const standing = standingForSelector(peopleResult.value.standings, selector);
  if (standing?.direct_capabilities.length) {
    const result = await removePersonShare(config, target, standing.user_id);
    let effectiveCapabilities: ShareCapability[] | null = null;
    let effectiveCapabilitiesUnavailable: string | null = null;
    try {
      const after = await listPersonShares(config, target);
      effectiveCapabilities =
        after.standings.find((row) => row.user_id === standing.user_id)?.effective_capabilities ?? [];
    } catch (err) {
      effectiveCapabilitiesUnavailable = errorText(err);
    }
    const verified = {
      ...result,
      effective_read_remains: effectiveCapabilities?.includes("read") ?? null,
      effective_capabilities: effectiveCapabilities,
      effective_capabilities_unavailable: effectiveCapabilitiesUnavailable,
    };
    const remains = effectiveCapabilities === null
      ? " Direct access was removed, but remaining access could not be checked."
      : effectiveCapabilities.length
        ? ` ${recipientName(standing)} still has ${capabilitySummary(effectiveCapabilities)} through another path.`
        : "";
    output.result(
      verified,
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

async function resendInvitation(
  rest: string[],
  flags: Flags,
  output: Output,
): Promise<number> {
  const email = rest[0];
  const selector = email ? personSelector(email) : null;
  if (!email || rest.length !== 1 || !selector || !("email" in selector)) {
    output.error("Usage: ideaspaces share resend <email> [--repo <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(repoFlag(flags), config, output);
  if (!target) return 1;
  const collection = await listPersonShareInvites(config, target);
  const invite = collection.invites.find(
    (row) => row.invited_email.toLowerCase() === selector.email.toLowerCase(),
  );
  if (!invite) {
    output.error(`${email} has no pending invitation here.`);
    return 1;
  }
  if (!invite.can_resend) {
    const wait = invite.resend_retry_after_seconds;
    output.error(
      wait && wait > 0
        ? `That invitation cannot be resent yet. Try again in ${wait} second${wait === 1 ? "" : "s"}.`
        : "That invitation cannot be resent right now.",
    );
    return 1;
  }
  const resent = await resendPersonShareInvite(config, target, invite.invite_id);
  output.result(
    resent,
    resent.delivery_status === "failed"
      ? `Tried to resend the invitation to ${resent.invited_email}, but delivery failed${resent.delivery_error ? `: ${resent.delivery_error}` : "."}`
      : `Resent the ${resent.grade} invitation to ${resent.invited_email}.`,
  );
  return 0;
}

async function setHistory(
  rest: string[],
  flags: Flags,
  output: Output,
): Promise<number> {
  const who = rest[0];
  const requested = rest[1]?.toLowerCase();
  const selector = who ? personSelector(who) : null;
  if (!who || !selector || (requested !== "on" && requested !== "off") || rest.length !== 2) {
    output.error("Usage: ideaspaces share history <email|@handle> <on|off> [--repo <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(repoFlag(flags), config, output);
  if (!target) return 1;
  const people = await listPersonShares(config, target);
  const standing = standingForSelector(people.standings, selector);
  if (!standing?.direct_capabilities.length) {
    output.error(`${who} has no direct person share here. Share with them before changing history.`);
    return 1;
  }
  const enabled = requested === "on";
  const result = await setPersonShareHistory(config, target, standing.user_id, enabled);
  if (result.status === "not_direct") {
    output.result(
      result,
      enabled
        ? `${recipientName(standing)} no longer has a direct person share, so hosted history was not enabled.`
        : `No direct hosted history remained for ${recipientName(standing)}. Other access was not changed by this command.`,
    );
    return 0;
  }
  output.result(
    result,
    result.status === "already_granted"
      ? `Hosted history was already on for ${recipientName(standing)}.`
      : `Hosted history is now ${enabled ? "on" : "off"} for ${recipientName(standing)}. Other access is unchanged.`,
  );
  return 0;
}

async function setVisibility(
  rest: string[],
  flags: Flags,
  output: Output,
  yes: boolean,
): Promise<number> {
  const requested = rest[0]?.toLowerCase();
  if ((requested !== "public" && requested !== "private") || rest.length !== 1) {
    output.error("Usage: ideaspaces share visibility <public|private> [--yes] [--repo <url>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;
  const target = await resolveTarget(repoFlag(flags), config, output);
  if (!target) return 1;
  const repoId = await repoIdForRoot(config, target);
  // Going public is an outward action: plan-first without --yes, applied only
  // on the explicit flag so no non-interactive mode can skip the agreement.
  // Going private reduces exposure and stays ungated.
  if (requested === "public" && !yes) {
    output.result(
      { plan: { action: "visibility", visibility: "public", repo_id: repoId }, applied: false },
      [
        "Plan — make this Space public.",
        "",
        "  Anyone can view and fork it locally without an account. Publishing",
        "  requires sign-in; Git history, clone, and push remain private.",
        "",
        "Nothing has changed yet — re-run with --yes to apply.",
      ].join("\n"),
    );
    return 0;
  }
  const result = await setSpaceAccess(config, repoId, {
    read_public: requested === "public",
    copy_access: requested === "public" ? "public" : "owner",
  });
  output.result(
    { ...result, visibility: requested },
    requested === "public"
      ? "Public — anyone can view and fork locally without an account. Publishing requires sign-in; Git history, clone, and push remain private."
      : "Private — public view and fork are off. Named people and team access are unchanged.",
  );
  return 0;
}

async function run(
  sub: string,
  rest: string[],
  flags: Flags,
  output: Output,
  yes: boolean,
): Promise<number> {
  try {
    switch (sub) {
      case "person":
        return await shareWithPerson(rest, flags, output);
      case "team":
        return await shareWithTeam(rest, flags, output);
      case "list":
        return await listProductAccess(rest, flags, output);
      case "visibility":
        return await setVisibility(rest, flags, output, yes);
      case "resend":
        return await resendInvitation(rest, flags, output);
      case "history":
        return await setHistory(rest, flags, output);
      case "remove":
        if (rest.length === 2 && rest[0]?.startsWith("repo_")) {
          output.error(
            "Repository-member removal was retired. Use `ideaspaces share remove <email|@handle|team:hostname>`.",
          );
          return 1;
        }
        return await removeProductAccess(rest, flags, output);
      case "access":
      case "set-access":
      case "members":
      case "invites":
      case "legacy-invite":
      case "revoke":
      case "invite":
      case "people":
      case "unshare":
        return rejectLegacyShare(sub, output);
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
  description: "Share a Space and manage recipient access",
  usage: USAGE,
  examples: [
    "ideaspaces share person someone@example.com --grade explore",
    "ideaspaces share person @someone --grade fork",
    "ideaspaces share person someone@example.com --grade collaborate --history",
    "ideaspaces share team acme.com --grade collaborate",
    "ideaspaces share list",
    "ideaspaces share resend someone@example.com",
    "ideaspaces share history @someone off",
    "ideaspaces share remove someone@example.com",
    "ideaspaces share remove team:acme.com",
    "ideaspaces share visibility public        # plan only — shows what opens up",
    "ideaspaces share visibility public --yes  # apply",
    "ideaspaces share visibility private --repo https://ideaspaces.xyz/repos/n_0123456789abcdef01234567",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    // `--repo` is parsed as a global flag, so it never reaches command flags.
    // Fold it back in here rather than threading it through every subcommand.
    const withRepo: Flags =
      global.repo === undefined ? flags : { repo: global.repo, ...flags };
    return run(sub ?? "", rest, withRepo, output, global.yes === true);
  },
};
