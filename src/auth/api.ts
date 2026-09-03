/**
 * Thin fetch helpers for the IdeaSpaces server API.
 *
 * Lives in CLI for now — the SDK is local-first after the refactor and
 * has no remote surface. When a second caller appears (mcp-server,
 * plugin), lift these to `@ideaspaces/sdk`.
 *
 * Routing note: auth endpoints sit at top-level (`/auth/*`); repo and
 * other resource endpoints are versioned under `/api/v1/*`. Mixed by
 * design on the server; mirrored here.
 */

const API_V1 = "/api/v1";

export interface PublicApiConfig {
  apiUrl: string;
  /** Present only when the caller has ambient credentials worth sending. */
  apiKey?: string;
}

export interface ApiConfig extends PublicApiConfig {
  apiKey: string;
}

export type RepoRouteStatus = "resolved" | "unresolved" | "conflict" | "unavailable";

export interface AuthMeRepo {
  repo_id: string;
  slug?: string | null;
  hostname?: string | null;
  /** Deprecated compatibility fields; root actions and receipts are authoritative. */
  role?: string | null;
  member_count?: number | null;
  name?: string | null;
  archived?: boolean;
  receipt_classes?: string[];
  receipt_subjects?: string[];
  actions?: Array<"open" | "copy" | "clone" | "collaborate">;
  root_node_id?: string | null;
  route_status?: RepoRouteStatus;
  route_kind?: "person" | "hostname" | null;
  route_namespace?: string | null;
  route_slug?: string | null;
  canonical_path?: string | null;
  legacy_path?: string | null;
  route_reason_codes?: string[];
}

export interface AuthMeResponse {
  user_id: number;
  username: string | null;
  email: string | null;
  name: string | null;
  repos: AuthMeRepo[];
  onboarding_complete: boolean;
}

export interface CreateRepoBody {
  name: string;
  slug?: string;
  hostname?: string | null;
  /** Prescribed local identity adopted atomically on first registration. */
  root_node_id?: string;
}

export interface CreateRepoResult {
  repo_id: string;
  root_node_id: string;
  slug: string;
  name: string;
}

export interface PublicSpaceResult {
  kind: "space";
  node_id: string;
  container_node_id: string;
  name: string;
  canonical_url: string;
  copy_enabled: boolean;
  login_required_to_copy: boolean;
  summary: string | null;
  readme_markdown: string | null;
}

export interface SpaceCopySnapshotFile {
  path: string;
  content: string;
}

export interface SpaceCopySnapshotAsset {
  path: string;
  content_base64: string;
}

export interface SpaceCopySnapshotResult {
  source_head: string;
  markdown_file_count: number;
  markdown_bytes: number;
  files: SpaceCopySnapshotFile[];
  asset_file_count: number;
  asset_bytes: number;
  assets: SpaceCopySnapshotAsset[];
}

/** Default request timeout — protects callers from indefinite hangs on a
 * partially-up or slow server. Override via `opts.timeoutMs` per call. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** Derive the git host URL from the api URL by swapping the `api.`
 * subdomain for `git.`. `IS_GIT_URL` env override wins for dev/localhost
 * setups where the convention can't be inferred (no `api.` prefix). */
export function deriveGitBase(apiUrl: string): string {
  const override = process.env.IS_GIT_URL;
  if (override) return override.replace(/\/+$/, "");
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) {
      url.hostname = "git." + url.hostname.slice(4);
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return apiUrl.replace(/\/+$/, "");
  }
}

/** Derive the user-facing web URL from the api URL by dropping the `api.`
 * subdomain. `IS_WEB_URL` env override wins for dev/localhost. */
export function deriveWebBase(apiUrl: string): string {
  const override = process.env.IS_WEB_URL;
  if (override) return override.replace(/\/+$/, "");
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) {
      url.hostname = url.hostname.slice(4);
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return apiUrl.replace(/\/+$/, "");
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Retry an idempotent GET once on timeout (default true). Set false for
   * latency-sensitive best-effort calls that prefer a fast fallback over
   * absorbing a cold start. */
  retry?: boolean;
}

/** Thrown on 401 so callers can recognize "session expired" without
 * string-matching on error.message. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the API host can't be reached — distinct from HTTP/auth errors,
 * so callers (and the Cowork redirect) can tell "network unreachable" apart. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Read through ambient credentials when present, then retry one authenticated
 * 401 without Authorization so an expired token cannot hide a public Space.
 *
 * Every other refusal keeps its original auth mode. In particular, a neutral
 * 404 from a denied private source must not become an anonymous policy probe.
 */
export async function optionalAuthRead<T>(
  config: PublicApiConfig,
  read: (current: PublicApiConfig) => Promise<T>,
): Promise<{ value: T; config: PublicApiConfig }> {
  try {
    return { value: await read(config), config };
  } catch (err) {
    if (err instanceof UnauthorizedError && config.apiKey) {
      const anonymous = { apiUrl: config.apiUrl };
      return { value: await read(anonymous), config: anonymous };
    }
    throw err;
  }
}

/** undici's fetch throws `TypeError: fetch failed` for connect/DNS/reset errors
 * (the errno rides on `.cause`) — as opposed to an HTTP status or a JSON parse
 * error, which surface as ordinary Errors / SyntaxErrors. */
function isConnectionFailure(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** Unreachable-host message with the conditional Cowork redirect. We can't
 * detect Cowork, so we suggest rather than assert; `timedOut` keeps the softer
 * "timed out" wording (a slow cold start is also possible). */
function unreachableMessage(apiUrl: string, timedOut: boolean): string {
  let host = apiUrl;
  try {
    host = new URL(apiUrl).host;
  } catch {
    // Non-URL apiUrl — fall back to the raw string.
  }
  const lead = timedOut
    ? `Reaching ${host} timed out — the server may be slow, or the network unreachable.`
    : `Can't reach ${host} — the network looks unreachable.`;
  return `${lead} If you're in Cowork, its sandbox blocks remote access — switch to Claude Code view to browse and sync (local capture still works).`;
}

/** Optional auth + JSON headers, shared so streaming and public reads cannot drift. */
function authHeaders(config: PublicApiConfig, extra?: Record<string, string>): Record<string, string> {
  const apiKey = config.apiKey?.trim();
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

async function request<T>(
  config: PublicApiConfig,
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Retry an idempotent GET once if the first attempt times out: the first call
  // warms a cold-started server (which can take ~9s), and the retry then lands
  // on a warm one (~0.1s), so cold starts self-heal instead of surfacing a
  // timeout. GET only — repeating it is safe; POST/PUT/etc. could double-apply,
  // so they fail fast. Non-timeout errors (401, 5xx, network) never retry.
  const maxAttempts = method === "GET" && opts.retry !== false ? 2 : 1;
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${config.apiUrl}${path}`, {
        method,
        headers: authHeaders(config),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const text = await r.text();
        if (r.status === 401) {
          throw new UnauthorizedError(`${method} ${path} → 401: ${text || r.statusText}`);
        }
        throw new Error(`${method} ${path} → ${r.status}: ${text || r.statusText}`);
      }
      // Tolerate an empty body (e.g. a 204 from DELETE) — return undefined
      // rather than throwing on `r.json()` of nothing.
      if (r.status === 204) return undefined as T;
      const payload = await r.text();
      return (payload ? JSON.parse(payload) : undefined) as T;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      if (timedOut && attempt < maxAttempts) continue; // warm-up retry
      if (timedOut) {
        throw new NetworkError(unreachableMessage(config.apiUrl, true));
      }
      if (isConnectionFailure(err)) {
        throw new NetworkError(unreachableMessage(config.apiUrl, false));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fetch the OAuth-resolved identity. Authenticates the stored credentials. */
export async function fetchAuthMe(config: ApiConfig, opts?: RequestOptions): Promise<AuthMeResponse> {
  return request<AuthMeResponse>(config, "GET", "/auth/me", undefined, opts);
}

/** Create a server-side bare repo. Returns repo_id + slug + name.
 *
 * The server creates the repo with no refs and no scaffold — first push
 * from the client establishes refs/heads/main. Pre-receive's force-push
 * guard short-circuits on ZERO_OID for ref creation.
 */
export async function createRepo(
  config: ApiConfig,
  body: CreateRepoBody,
  opts?: RequestOptions,
): Promise<CreateRepoResult> {
  return request<CreateRepoResult>(config, "POST", `${API_V1}/repos`, body, opts);
}

export async function getSpace(
  config: PublicApiConfig,
  rootNodeId: string,
  opts?: RequestOptions,
): Promise<PublicSpaceResult> {
  return request<PublicSpaceResult>(
    config,
    "GET",
    `${API_V1}/spaces/${encodeURIComponent(rootNodeId)}`,
    undefined,
    opts,
  );
}

export async function getSpaceCopySnapshot(
  config: PublicApiConfig,
  rootNodeId: string,
  opts?: RequestOptions,
): Promise<SpaceCopySnapshotResult> {
  return request<SpaceCopySnapshotResult>(
    config,
    "GET",
    `${API_V1}/spaces/${encodeURIComponent(rootNodeId)}/copy-snapshot`,
    undefined,
    opts,
  );
}

/** One commit on the Space's trail, as the temporal endpoint reports it. */
export interface TrailCommit {
  sha: string;
  message: string;
  date: string;
  author: string;
  files?: string[];
  op?: string;
}

/** One path's fate between two commits. `status` is git's A/M/D/R/C. */
export interface TrailChange {
  status: string;
  path: string;
  old_path?: string;
}

/**
 * Turn the trail endpoint's fail-closed refusal into something the holder of a
 * clone can act on. Returns null when the error is not one of its refusals.
 *
 * The server answers **404 for every refusal**, deliberately: a stranger
 * probing root node ids must not learn which Spaces exist. That is right on the
 * wire and wrong in the terminal — the person running this is standing inside a
 * clone of the Space they are being told does not exist. Translating locally
 * leaks nothing, because they already hold the coordinate.
 *
 * The reason code rides in the detail (`Space not found (no_history_relation)`),
 * which is the server telling us which refusal this is. It was going unread.
 *
 * **Why this string-matches when `UnauthorizedError` exists precisely so callers
 * need not.** A typed error would have to be minted in `request()`, which every
 * endpoint shares — putting trail-specific reason codes in the one helper that
 * knows nothing about trails, and teaching it to classify 404s that mean
 * something different for every other caller. The parsing stays here, reachable
 * only by callers that opt in. If a third trail reason code appears, that is the
 * point to promote these to a structured type rather than lengthen this chain.
 */
export function describeTrailRefusal(
  err: unknown,
  context: "clone" | "source" = "clone",
): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("→ 404")) return null;

  const subject = context === "source" ? "source Space" : "Space";
  if (message.includes("no_history_relation")) {
    return (
      `The ${subject}'s trail has not been shared with you — reading its content and reading how it got ` +
      "here are separate permissions. Ask whoever owns it to share history, then try again."
    );
  }
  if (message.includes("no_read_relation")) {
    return (
      `You no longer have read access to the ${subject}, so its trail is out of reach too. ` +
      "Your local clone is unaffected — ask whoever owns it to share it again."
    );
  }
  // A 404 with no reason code: the Space is genuinely gone, or the recorded
  // coordinate no longer resolves. A fork's source coordinate cannot be
  // repaired by re-linking the fork, so the two contexts need different exits.
  return context === "source"
    ? "The recorded source Space could not be found. It may have been deleted or its recorded coordinate may be stale."
    : (
        "The Space this clone points at could not be found. It may have been deleted, or this clone's " +
        "record may be stale — `ideaspaces link .` re-binds it."
      );
}

/**
 * Read a Space's trail by its stable root coordinate.
 *
 * Addressed by root node id rather than `repo_id` deliberately: the
 * `repo_id` route gates on repo membership, so a person who was shared with —
 * or a fork — cannot reach it. This one requires both Content read and explicit
 * hosted-history authority.
 *
 * Read-only on both sides. It never writes to the Space and never touches the
 * local working tree.
 */
export async function fetchTrailLog(
  config: ApiConfig,
  rootNodeId: string,
  limit: number,
  opts?: RequestOptions,
): Promise<{ op: string; entries: TrailCommit[] }> {
  return request(
    config,
    "GET",
    `${API_V1}/spaces/${encodeURIComponent(rootNodeId)}/git?op=log&limit=${encodeURIComponent(String(limit))}`,
    undefined,
    opts,
  );
}

/** Paths the Space changed since `since` — a commit the server's repo holds. */
export async function fetchTrailChanges(
  config: ApiConfig,
  rootNodeId: string,
  since: string,
  opts?: RequestOptions,
): Promise<{ op: string; since: string; changes: TrailChange[] }> {
  return request(
    config,
    "GET",
    `${API_V1}/spaces/${encodeURIComponent(rootNodeId)}/git?op=changes&since=${encodeURIComponent(since)}`,
    undefined,
    opts,
  );
}

export interface ConversationSummary {
  conversation_id: string;
  name: string;
  summary: string;
  message_count: number;
  status: string;
  updated_at: string;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  total: number;
}

/** List a repo's conversations (newest-first is the server's default order). */
export async function fetchConversations(
  config: ApiConfig,
  repoId: string,
  opts?: RequestOptions,
): Promise<ConversationsResponse> {
  return request<ConversationsResponse>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations?limit=50&offset=0`,
    undefined,
    opts,
  );
}

export interface CreateConversationBody {
  name?: string;
  /** Agent Actor node_id to run the conversation. Accepted by the server and
   * honored once backend agent-selection lands — forward-compatible, matching
   * a client's start flow (the picker passes it through today). */
  agent_node_id?: string;
}

export interface CreateConversationResult {
  conversation_id: string;
  node_id?: string;
  repo_id?: string;
  name?: string;
  selected_agent_node_id?: string;
  ephemeral?: boolean;
}

/** Create a bare conversation shell (no message). The server fills defaults
 * (name "New conversation", agent `keeper`) for omitted fields. */
export async function createConversation(
  config: ApiConfig,
  repoId: string,
  body: CreateConversationBody = {},
  opts?: RequestOptions,
): Promise<CreateConversationResult> {
  return request<CreateConversationResult>(
    config,
    "POST",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations`,
    body,
    opts,
  );
}

export interface Agent {
  /** Actor node_id that owns this agent (person/org). */
  owner_actor_node_id: string;
  /** Agent Actor node_id — what create/select takes. */
  node_id: string;
  /** Canonical identity, `agent:{node_id}`. */
  identity: string;
  name: string;
  summary: string;
  /** Whether the current user may invoke this agent. */
  can_use: boolean;
  /** Whether this is the owner's default agent. */
  is_default: boolean;
}

interface AgentListResponse {
  agents: Agent[];
}

/**
 * List selectable Agent Actors (`GET /api/v1/agents`). Without `owner`, the
 * caller's own agents; with it (`person:{username}` | `hostname:{domain}`,
 * membership-checked server-side), that context's agents. Owner default first,
 * flagged by `is_default`. User-scoped — no Space required.
 */
export async function fetchAgents(
  config: ApiConfig,
  owner?: string,
  opts?: RequestOptions,
): Promise<Agent[]> {
  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  const res = await request<AgentListResponse>(
    config,
    "GET",
    `${API_V1}/agents${qs}`,
    undefined,
    opts,
  );
  return res.agents;
}

export interface InboxParticipant {
  participant: string;
  username: string | null;
  name: string | null;
  person_node_id: string | null;
}

export interface ExchangeMessageSummary {
  note_node_id: string;
  name: string;
  summary: string;
  author_ref: string;
  actor_ref: string;
  surface: "human" | "agent";
  action: "inquiry.opened" | "note.replied";
  recipient_ref: string;
  position: number;
  created_at: string;
  event_at: string;
}

export interface ExchangeMessage extends ExchangeMessageSummary {
  markdown: string;
}

export interface InboxItem {
  kind: "inquiry";
  mode: "direct";
  exchange_id: string;
  target_node_id: string;
  participants: InboxParticipant[];
  opening_note: ExchangeMessageSummary;
  latest_message: ExchangeMessageSummary;
  latest_position: number;
  latest_received_position: number;
  message_count: number;
  received_message_count: number;
}

export interface InboxResponse {
  items: InboxItem[];
}

export interface ExchangeReadResponse {
  mode: "direct";
  exchange_id: string;
  target_node_id: string;
  participants: InboxParticipant[];
  messages: ExchangeMessage[];
}

export interface ExchangeNoteWrite {
  send_id: string;
  name: string;
  summary: string;
  markdown: string;
}

export interface InquirySendBody extends ExchangeNoteWrite {
  target_node_id: string;
  recipient: { user_id: number } | { username: string } | { email: string };
}

export interface ExchangeWriteResponse {
  note_node_id: string;
  exchange_id: string;
  event_id: string;
  position: number;
  created_at: string;
  target_node_id: string;
  author_ref: string;
  recipient_ref: string;
  actor_ref: string;
  surface: "human" | "agent";
  action: "inquiry.opened" | "note.replied";
}

/** Direct exchanges received by the logged-in person, newest activity first. */
export async function fetchInbox(
  config: ApiConfig,
  opts?: RequestOptions,
): Promise<InboxResponse> {
  return request<InboxResponse>(config, "GET", `${API_V1}/inbox`, undefined, opts);
}

/** Complete immutable message history for one exchange. Non-parties receive the same 404 as absent ids. */
export async function fetchExchange(
  config: ApiConfig,
  exchangeId: string,
  opts?: RequestOptions,
): Promise<ExchangeReadResponse> {
  return request<ExchangeReadResponse>(
    config,
    "GET",
    `${API_V1}/exchanges/${encodeURIComponent(exchangeId)}`,
    undefined,
    opts,
  );
}

/** Open a direct inquiry about a readable Content target as the logged-in person. */
export async function sendInquiry(
  config: ApiConfig,
  body: InquirySendBody,
  opts?: RequestOptions,
): Promise<ExchangeWriteResponse> {
  return request<ExchangeWriteResponse>(config, "POST", `${API_V1}/inquiries`, body, opts);
}

/** Reply through an existing direct exchange as the logged-in person. */
export async function replyToExchange(
  config: ApiConfig,
  exchangeId: string,
  body: ExchangeNoteWrite,
  opts?: RequestOptions,
): Promise<ExchangeWriteResponse> {
  return request<ExchangeWriteResponse>(
    config,
    "POST",
    `${API_V1}/exchanges/${encodeURIComponent(exchangeId)}/replies`,
    body,
    opts,
  );
}

export interface NodeDetail {
  node_id: string;
  name: string;
  /** Display-name override from frontmatter, when present. */
  name_display?: string;
  summary?: string;
  content: string;
  path: string;
  node_type: string;
  tags?: string[];
  updated_at?: string | null;
  created_at?: string | null;
}

/**
 * Fetch a node's detail by id (`GET /api/v1/repos/{id}/nodes/{nodeId}`) — name,
 * path, and content. Backs resolving a conversation's workspace node-ids to
 * names + a preview (no batch endpoint yet, so callers resolve per node).
 */
export async function fetchNode(
  config: ApiConfig,
  repoId: string,
  nodeId: string,
  opts?: RequestOptions,
): Promise<NodeDetail> {
  return request<NodeDetail>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/nodes/${encodeURIComponent(nodeId)}`,
    undefined,
    opts,
  );
}

export interface WriteFileResponse {
  path: string;
  commit_sha: string;
  node_id: string | null;
}

// Encode each path segment individually — encodeURIComponent on the whole path
// would turn `/` into %2F. Mirrors the server's files route.
function filesPath(repoId: string, path: string): string {
  const segs = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${API_V1}/repos/${encodeURIComponent(repoId)}/files/${segs}`;
}

/**
 * Write a file's content on the server (`PUT /repos/{id}/files/{path}`) — the
 * same endpoint the web client edits through. `name` is omitted, so the backend keeps
 * the existing display name (body-only edit). 403 when the caller can't write
 * the repo (surfaced to the user as read-only).
 */
export async function putFile(
  config: ApiConfig,
  repoId: string,
  path: string,
  content: string,
  opts?: RequestOptions,
): Promise<WriteFileResponse> {
  return request<WriteFileResponse>(config, "PUT", filesPath(repoId, path), { content }, opts);
}

// ── Sharing: members, invites, and the public-link access policy ──────────────
// The data behind the Share dialog. All owner-gated on
// the backend — a non-owner caller gets a 403.

/**
 * Roles the legacy repo-invite endpoint still accepts from this CLI.
 *
 * `CLONER` is not representable here on purpose. The capability it named —
 * may take a copy — is a grade on a target now (`ShareGrade["fork"]`), and a
 * type that can still spell the old word is a type that lets it come back.
 */
export type InviteRole = "MEMBER" | "READER";
/**
 * A role the backend may *report* — deliberately not derived from `InviteRole`.
 *
 * Narrowing what this CLI may send is a decision about our writes. It says
 * nothing about existing state: nothing migrates a legacy repo's `CLONER`
 * members or pending invites, so the server can still hand one back. A read
 * type that inherits the write type's narrowing is a type that lies, and the
 * next exhaustive `switch` over it would be wrong in a way the compiler
 * endorses.
 */
export type MemberRole = "OWNER" | "MEMBER" | "READER" | "CLONER";
export type CopyAccessLevel = "owner" | "member" | "reader" | "public";

export interface Member {
  user_id: number;
  username: string | null;
  email: string | null;
  role: MemberRole;
}

export interface PendingInvite {
  invite_id: string;
  invited_email: string;
  role: MemberRole; // reported, not sent — may still be CLONER on a legacy repo
  expires_at: string;
  created_at: string;
}

export interface InviteResult {
  email: string;
  status: "sent" | "already_member" | "already_invited" | "invalid_hostname" | "email_failed";
  invite_id?: string;
  reason?: string;
}

export interface CreateInvitesResponse {
  results: InviteResult[];
}

export interface SpaceAccessResponse {
  repo_id: string;
  root_node_id: string;
  read_public: boolean;
  copy_public: boolean;
  copy_access: CopyAccessLevel;
}

export interface SpaceAccessUpdate {
  read_public: boolean;
  copy_access: CopyAccessLevel;
}

const repoBase = (repoId: string) => `${API_V1}/repos/${encodeURIComponent(repoId)}`;

/**
 * What a Space can be shared *as*. One grade per invitation, mutually exclusive.
 *
 * These replace the repository roles the product used to hand out. `CLONER` in
 * particular is gone: "may copy" is now `fork`, expressed as a relationship on
 * a target rather than a seat in a repo.
 */
export type ShareGrade = "explore" | "fork" | "collaborate";
export type ShareCapability =
  | "read"
  | "write"
  | "history"
  | "space_copy"
  | "git_fetch"
  | "git_push";

export interface PersonShareRelationship {
  user_id: number;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  account_status: "active" | "closed" | "unresolved" | "missing";
  access: "view" | "existing_write";
  share_history: boolean;
  shared_at?: string | null;
}

export interface PersonShareStanding {
  user_id: number;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  account_status: "active" | "closed" | "unresolved" | "missing";
  direct_capabilities: ShareCapability[];
  effective_capabilities: ShareCapability[];
  shared_at?: string | null;
}

export interface PendingContentInvite {
  invite_id: string;
  invited_email: string;
  intent_kind: "content" | "process";
  grade: ShareGrade;
  share_history: boolean;
  created_at: string;
  expires_at: string;
  delivery_status: "unknown" | "sending" | "sent" | "failed";
  delivery_error?: string | null;
  can_resend: boolean;
  resend_retry_after_seconds?: number | null;
}

/**
 * The server's answer to one share attempt.
 *
 * `status` carries the outcomes that are not failures and not plain successes —
 * the recipient already had direct access, the address is the caller's own, the
 * person has no account and was invited instead. Reporting which one happened
 * is the point: they need different things said to the person sharing.
 */
export interface PersonShareAddResult {
  target_node_id: string;
  grade: ShareGrade;
  share_history: boolean;
  status:
    | "added"
    | "already_direct"
    | "self"
    | "no_match"
    | "recipient_unavailable"
    | "invited"
    | "already_pending";
  recipient_route: string;
  relationship?: PersonShareRelationship | null;
  pending_invite?: PendingContentInvite | null;
}

export interface PersonShareCollection {
  target_node_id: string;
  target_type: "repo" | "dir" | "note";
  recipient_route: string;
  actions: {
    can_manage_existing: boolean;
    can_add: boolean;
    manage_blocked_reason?: string | null;
    add_blocked_reason?: string | null;
  };
  relationships: PersonShareRelationship[];
  standings: PersonShareStanding[];
}

export interface PersonShareRemoveResult {
  target_node_id: string;
  user_id: number;
  status: "removed" | "not_direct";
  effective_read_remains: boolean;
  effective_capabilities: ShareCapability[];
}

export type TeamShareCapability = "read" | "space_copy" | "git_fetch" | "git_push";

export interface EligibleTeamAudience {
  audience: "org_members";
  hostname: string;
  org_node_id: string;
  grantee: string;
  label: string;
  role: "MEMBER" | "OWNER";
}

export interface TeamShareRelationship {
  org_node_id: string;
  hostname?: string | null;
  registered: boolean;
  direct_capabilities: TeamShareCapability[];
  grade: ShareGrade | null;
  shared_at?: string | null;
  expires_at?: string | null;
}

export interface TeamShareCollection {
  target_node_id: string;
  relationships: TeamShareRelationship[];
}

export interface TeamShareMutationResult {
  target_node_id: string;
  org_node_id: string;
  status: "shared" | "already_shared" | "removed" | "not_direct";
  relationship?: TeamShareRelationship | null;
}

const nodeBase = (nodeId: string) => `${API_V1}/nodes/${encodeURIComponent(nodeId)}`;

/**
 * Share one Content target with one person, at one grade.
 *
 * Addressed by node id, not `repo_id`: the caller is standing in a clone and
 * should never have to discover an internal repository identifier to share what
 * they are looking at.
 */
export async function addPersonShare(
  config: ApiConfig,
  targetNodeId: string,
  body: {
    email?: string;
    username?: string;
    user_id?: number;
    invite_if_no_match?: boolean;
    grade: ShareGrade;
    share_history?: boolean;
  },
  opts?: RequestOptions,
): Promise<PersonShareAddResult> {
  return request(config, "POST", `${nodeBase(targetNodeId)}/person-shares`, body, opts);
}

/** Who already holds direct access to a target, and whether this caller may change it. */
export async function listPersonShares(
  config: ApiConfig,
  targetNodeId: string,
  opts?: RequestOptions,
): Promise<PersonShareCollection> {
  return request(config, "GET", `${nodeBase(targetNodeId)}/person-shares`, undefined, opts);
}

/**
 * Turn a person-share refusal into a sentence, or null if it is not one.
 *
 * The common case is not a bug and not the caller's fault: a Space whose
 * ownership ledger was never established cannot hold direct person
 * relationships, and most existing Spaces are in that state. Rendering the raw
 * 409 body puts `root_governance_unestablished` in front of someone who asked
 * to share a folder.
 */
export function describeShareRefusal(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("root_governance_unestablished")) {
    return (
      "This Space cannot share with a person directly yet — its ownership record was never " +
      "established, which is true of most Spaces created before the change.\n" +
      "The older path still works for it: ideaspaces share legacy-invite <repo_id> <email> --role READER"
    );
  }
  if (message.includes("→ 409") && message.includes("Person Share is unavailable")) {
    return "Direct person sharing is unavailable for this Space.";
  }
  return null;
}

/** Withdraw one person's direct access to a target. */
export async function removePersonShare(
  config: ApiConfig,
  targetNodeId: string,
  userId: number,
  opts?: RequestOptions,
): Promise<PersonShareRemoveResult> {
  return request(
    config,
    "DELETE",
    `${nodeBase(targetNodeId)}/person-shares/${encodeURIComponent(String(userId))}`,
    undefined,
    opts,
  );
}

/** Withdraw an invitation that has not been accepted yet. */
export async function revokePersonShareInvite(
  config: ApiConfig,
  targetNodeId: string,
  inviteId: string,
  opts?: RequestOptions,
): Promise<void> {
  return request(
    config,
    "DELETE",
    `${nodeBase(targetNodeId)}/person-share-invites/${encodeURIComponent(inviteId)}`,
    undefined,
    opts,
  );
}

/** Invitations sent for a target and not yet accepted. */
export async function listPersonShareInvites(
  config: ApiConfig,
  targetNodeId: string,
  opts?: RequestOptions,
): Promise<{ invites: PendingContentInvite[] }> {
  return request(config, "GET", `${nodeBase(targetNodeId)}/person-share-invites`, undefined, opts);
}

/** Registered teams the current person may select without handling internal Actor ids. */
export async function listEligibleTeamAudiences(
  config: ApiConfig,
  opts?: RequestOptions,
): Promise<EligibleTeamAudience[]> {
  return request(config, "GET", `${API_V1}/nodes/grant-audiences`, undefined, opts);
}

export async function listTeamShares(
  config: ApiConfig,
  rootNodeId: string,
  opts?: RequestOptions,
): Promise<TeamShareCollection> {
  return request(config, "GET", `${nodeBase(rootNodeId)}/team-shares`, undefined, opts);
}

export async function setTeamShare(
  config: ApiConfig,
  rootNodeId: string,
  orgNodeId: string,
  grade: ShareGrade,
  opts?: RequestOptions,
): Promise<TeamShareMutationResult> {
  return request(
    config,
    "PUT",
    `${nodeBase(rootNodeId)}/team-shares/${encodeURIComponent(orgNodeId)}`,
    { grade },
    opts,
  );
}

export async function removeTeamShare(
  config: ApiConfig,
  rootNodeId: string,
  orgNodeId: string,
  opts?: RequestOptions,
): Promise<TeamShareMutationResult> {
  return request(
    config,
    "DELETE",
    `${nodeBase(rootNodeId)}/team-shares/${encodeURIComponent(orgNodeId)}`,
    undefined,
    opts,
  );
}

export async function listRepoMembers(config: ApiConfig, repoId: string): Promise<Member[]> {
  return request<Member[]>(config, "GET", `${repoBase(repoId)}/members`);
}

export async function removeRepoMember(
  config: ApiConfig,
  repoId: string,
  userId: number,
): Promise<void> {
  await request(config, "DELETE", `${repoBase(repoId)}/members/${encodeURIComponent(String(userId))}`);
}

export async function listRepoInvites(config: ApiConfig, repoId: string): Promise<PendingInvite[]> {
  return request<PendingInvite[]>(config, "GET", `${repoBase(repoId)}/invites`);
}

export async function createRepoInvites(
  config: ApiConfig,
  repoId: string,
  emails: string[],
  role: InviteRole,
): Promise<CreateInvitesResponse> {
  return request<CreateInvitesResponse>(config, "POST", `${repoBase(repoId)}/invites`, {
    emails,
    role,
  });
}

export async function revokeRepoInvite(
  config: ApiConfig,
  repoId: string,
  inviteId: string,
): Promise<void> {
  await request(config, "DELETE", `${repoBase(repoId)}/invites/${encodeURIComponent(inviteId)}`);
}

export async function getSpaceAccess(
  config: ApiConfig,
  repoId: string,
): Promise<SpaceAccessResponse> {
  return request<SpaceAccessResponse>(config, "GET", `${repoBase(repoId)}/space-access`);
}

export async function setSpaceAccess(
  config: ApiConfig,
  repoId: string,
  update: SpaceAccessUpdate,
): Promise<SpaceAccessResponse> {
  return request<SpaceAccessResponse>(config, "PATCH", `${repoBase(repoId)}/space-access`, update);
}

export type ParticipantRole = "owner" | "member" | "reader";

export interface ConversationParticipant {
  id: string | null;
  process_node_id: string;
  /** Canonical principal: `person:{username}` / `agent:{node}` / `node:{id}`. */
  participant: string;
  role: ParticipantRole;
  joined_at: string | null;
  joined_via: string | null;
  revoked_at: string | null;
}

export interface ParticipantsResponse {
  participants: ConversationParticipant[];
}

/** List a conversation's active participants (owner is synthesized; revoked
 * rows are excluded). Conversation-keyed — no Space required. */
export async function listParticipants(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  opts?: RequestOptions,
): Promise<ParticipantsResponse> {
  return request<ParticipantsResponse>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}/participants`,
    undefined,
    opts,
  );
}

/** Add a participant by raw principal (`person:`/`agent:`/`node:`). Owner only.
 * The server does not resolve usernames — the caller builds the principal. */
export async function addParticipant(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  participant: string,
  role: "member" | "reader" = "member",
  opts?: RequestOptions,
): Promise<ConversationParticipant> {
  return request<ConversationParticipant>(
    config,
    "POST",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}/participants`,
    { participant, role },
    opts,
  );
}

/** Revoke a participant by raw principal. Owner only. */
export async function removeParticipant(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  participant: string,
  opts?: RequestOptions,
): Promise<ConversationParticipant> {
  return request<ConversationParticipant>(
    config,
    "DELETE",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(participant)}`,
    undefined,
    opts,
  );
}

export interface RepoMember {
  user_id: number;
  username: string | null;
  email: string | null;
  role: string;
}

/** List a repo's members — the people addable to one of its conversations. */
export async function fetchRepoMembers(
  config: ApiConfig,
  repoId: string,
  opts?: RequestOptions,
): Promise<RepoMember[]> {
  return request<RepoMember[]>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/members`,
    undefined,
    opts,
  );
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  created_at?: string;
  author?: string;
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
  usage?: Record<string, unknown>;
}

/** Node ids the agent touched in a turn — the two-writer coherence signal. */
export interface ConversationWorkspace {
  created: string[];
  modified: string[];
  deleted: string[];
  read: string[];
  mentioned: string[];
}

export interface ConversationDetail {
  conversation_id: string;
  repo_id: string;
  name: string;
  node_id?: string;
  owner?: string;
  history: ConversationHistoryMessage[];
  active_turn: { task_id: string; status: string; thread_id?: string; event_count?: number } | null;
  workspace?: ConversationWorkspace;
  turn_count?: number;
  model_tier?: string;
  updated_at?: string | null;
}

/** A conversation's full detail + message history (drives the thread render). */
export async function getConversation(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  opts?: RequestOptions,
): Promise<ConversationDetail> {
  return request<ConversationDetail>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}`,
    undefined,
    opts,
  );
}

export interface CancelTurnResult {
  status: string;
  conversation_id: string;
}

/** Cancel the conversation's active turn (owner-only). */
export async function cancelConversationTurn(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  opts?: RequestOptions,
): Promise<CancelTurnResult> {
  return request<CancelTurnResult>(
    config,
    "DELETE",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}/current`,
    undefined,
    opts,
  );
}

export interface SendMessageBody {
  message: string;
  model_tier?: string;
  thinking?: boolean;
}

/** Extract the JSON payload from one SSE block (`event:`/`data:` lines), or null
 * for keep-alives / unparseable blocks. Multi-line `data:` is joined with LF per
 * the SSE spec (defensive — our JSON events are single-line in practice). */
function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Stream an agent turn: POST the message and yield each parsed SSE event as it
 * arrives. No request timeout — a turn runs as long as it runs; cancellation is
 * via the `signal`. The server keeps the turn alive past disconnect, so a
 * dropped stream isn't lost work (re-fetch the conversation to see the result).
 */
export async function* streamConversationMessage(
  config: ApiConfig,
  repoId: string,
  conversationId: string,
  body: SendMessageBody,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const path = `${API_V1}/repos/${encodeURIComponent(repoId)}/conversations/${encodeURIComponent(conversationId)}/messages/stream`;
  // Same auth as request(), but streaming needs getReader(), not r.json().
  const r = await fetch(`${config.apiUrl}${path}`, {
    method: "POST",
    headers: authHeaders(config, { Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (r.status === 401) {
      throw new UnauthorizedError(`POST ${path} → 401: ${text || r.statusText}`);
    }
    throw new Error(`POST ${path} → ${r.status}: ${text || r.statusText}`);
  }
  if (!r.body) throw new Error("stream: server returned no response body");

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Chunks split anywhere — even mid-line. Buffer, normalize CRLF, and only
      // emit blocks terminated by a blank line; keep the incomplete tail.
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
    const tail = (buffer + decoder.decode()).replace(/\r\n/g, "\n").trim();
    if (tail) {
      const event = parseSseBlock(tail);
      if (event) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader already closed/errored — nothing to release.
    }
  }
}
