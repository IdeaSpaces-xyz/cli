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
}

/** Thrown on 401 so callers can recognize "session expired" without
 * string-matching on error.message. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

async function request<T>(
  config: ApiConfig,
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
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
    return (await r.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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
