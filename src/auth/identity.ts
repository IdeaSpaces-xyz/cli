/** Format the IdeaSpaces email identity for a given username.
 *
 * The pre-receive hook recognizes `person:<username>@ideaspaces` via
 * `_IDENTITY_EMAIL_RE` without a DB lookup. Single source of truth so creation,
 * clone/link/fork wiring, and publish cannot drift on the format.
 */
export function identityEmail(username: string): string {
  return `person:${username}@ideaspaces`;
}

/** Commit display name for an account — its display name, else the username. */
export function identityName(me: { name: string | null; username: string }): string {
  return me.name ?? me.username;
}
