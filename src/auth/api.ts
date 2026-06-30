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

export interface ApiConfig {
  apiUrl: string;
  apiKey: string;
}

export interface AuthMeRepo {
  repo_id: string;
  slug: string;
  hostname: string | null;
  role: string;
  member_count: number;
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
}

export interface CreateRepoResult {
  repo_id: string;
  slug: string;
  name: string;
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

/** Auth + JSON headers, shared so the streaming path can't drift from request()
 * if auth ever grows (versioned header, signature, …). */
function authHeaders(config: ApiConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    ...extra,
  };
}

async function request<T>(
  config: ApiConfig,
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
        throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`);
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
   * is_web's start flow (the picker passes it through today). */
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
 * same endpoint is_web edits through. `name` is omitted, so the backend keeps
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
// The data behind the desktop's Share dialog (is_web parity). All owner-gated on
// the backend — a non-owner caller gets a 403.

export type InviteRole = "MEMBER" | "CLONER" | "READER";
export type MemberRole = "OWNER" | InviteRole;
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
  role: InviteRole;
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
