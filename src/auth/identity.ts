/** Format the IdeaSpaces email-identity for a given username.
 *
 * The pre-receive hook recognizes `person:<username>@ideaspaces` via
 * `_IDENTITY_EMAIL_RE` without a DB lookup. Single source of truth so
 * `create` (Layer 1) and `publish` (Layer 2) can't drift on the format.
 */
export function identityEmail(username: string): string {
  return `person:${username}@ideaspaces`;
}
