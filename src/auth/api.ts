import { resolveSessionConfig, refuseSession, SessionAuthError } from "./client-session.js";
import { HostAuthRefusal, isHostAuth } from "./credentials.js";
import { hostToken } from "./host-token.js";
import { outOfDateMessage } from "../update-check.js";

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
  /** Host-store session binding. Explicit env/API keys omit it. */
  sessionId?: string;
  /** Set only by hostedConfig() on the token read from --token-fd; see authHeaders. */
  host?: true;
}

export interface ApiConfig extends PublicApiConfig {
  apiKey: string;
}

export type RepoRouteStatus = "resolved" | "unresolved" | "conflict" | "unavailable";

export interface AuthMeRepo {
  repo_id: string;
  slug?: string | null;
  hostname?: string | null;
  name?: string | null;
  archived?: boolean;
  /** Current servers emit non-null arrays; absence grants no inferred relationship or action. */
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
  /** The canonical `/public/repos/{id}` route answers `repo`; older routes answered `space`. */
  kind: "space" | "repo";
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
  /** Throw ApiStatusError (status, body, Retry-After) for any non-2xx, after the usual sign-in renewal. */
  statusError?: boolean;
  /** Send `body` as-is with Content-Type text/plain (a hosted Thread post), not as JSON. */
  text?: boolean;
}

/** A non-2xx answer, kept typed for callers that map statuses to states (hosted Threads, Vaults). */
export class ApiStatusError extends Error {
  readonly retryAfterMs?: number;
  constructor(readonly status: number, readonly body: string, retryAfter: string | null) {
    super(`HTTP ${status}`);
    this.name = "ApiStatusError";
    const delay = retryAfter === null ? undefined : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (delay !== undefined && Number.isFinite(delay)) this.retryAfterMs = Math.max(0, delay);
  }
}

/** Thrown on 401 so callers can recognize "session expired" without
 * string-matching on error.message. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown on 410 — the server retired the route this CLI still calls, so the
 * fix is a newer CLI, not a different argument. Carries the server's own
 * message and says so plainly; a bare `410: {"detail":...}` reads as a
 * missing repo, which is how a month-old bundle once cost a person an
 * afternoon of "404 on every repo". */
export class RetiredEndpointError extends Error {
  constructor(method: string, path: string, body: string) {
    super(`${method} ${path} → 410: ${retiredEndpointMessage(body)}\n${outOfDateMessage()}`);
    this.name = "RetiredEndpointError";
  }
}

/** Pull the human message out of a 410 body — FastAPI `detail` as a string or
 * `{code, message}` object — falling back to the raw text. */
function retiredEndpointMessage(body: string): string {
  const fallback = body || "endpoint retired";
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // not JSON — show it as-is
  }
  return fallback;
}

/** Thrown when the API host can't be reached — distinct from HTTP/auth errors,
 * so callers (and the Cowork redirect) can tell "network unreachable" apart. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** An aborted request may have completed server-side; unlike a connection
 * failure, a timed-out write has an unknown outcome until it is read back. */
export class RequestTimeoutError extends NetworkError {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
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

/** Name the failing call. Only a known Claude plugin invocation gets Cowork advice;
 * other shells have no evidence that Claude Code (let alone Cowork) is running. */
function unreachableMessage(apiUrl: string, timedOut: boolean, call: string): string {
  let host = apiUrl;
  try {
    host = new URL(apiUrl).host;
  } catch {
    // Non-URL apiUrl — fall back to the raw string.
  }
  const lead = timedOut
    ? `Could not reach ${host}: ${call} timed out — the server may be slow, or the network unreachable.`
    : `Could not reach ${host}: ${call} failed — the network looks unreachable.`;
  return process.env.CLAUDE_PLUGIN_ROOT?.trim()
    ? `${lead} If you're in Cowork, its sandbox blocks remote access — switch to Claude Code view to browse and sync (local capture still works).`
    : lead;
}

/** Optional auth + JSON headers, shared so streaming and public reads cannot drift. */
async function authHeaders(config: PublicApiConfig, extra?: Record<string, string>): Promise<Record<string, string>> {
  // Every HTTP call passes here, public reads included. Host mode makes none, except a
  // hosted verb spending the exact token the host passed on --token-fd, at its service.
  if (isHostAuth()) {
    const token = hostToken();
    if (!(config.host && token && config.apiKey === token.accessToken && config.apiUrl === token.apiUrl && !config.sessionId)) {
      throw new HostAuthRefusal();
    }
  }
  let apiKey: string | undefined;
  try { apiKey = (await resolveSessionConfig(config)).apiKey?.trim(); }
  catch (error) {
    if (error instanceof SessionAuthError) throw new UnauthorizedError(error.message);
    throw error;
  }
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

/** One conditional rotation on access refusal; never spend a refresh already marked ambiguous. */
async function renewRefusedAccess(config: PublicApiConfig, key?: string): Promise<void> {
  try { await resolveSessionConfig(config, key); }
  catch (error) { if (error instanceof SessionAuthError) throw new UnauthorizedError(error.message); throw error; }
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
  let authRetried = false;
  for (let attempt = 1; ; attempt++) {
    const headers = await authHeaders(config, opts.text ? { "Content-Type": "text/plain; charset=utf-8" } : undefined);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${config.apiUrl}${path}`, {
        method,
        headers,
        redirect: "error",
        body: body === undefined ? undefined : opts.text ? String(body) : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const text = await r.text();
        if (r.status === 401) {
          if (config.sessionId && !authRetried) {
            authRetried = true;
            await renewRefusedAccess(config, headers.Authorization?.slice(7));
            if (method === "GET" && opts.retry !== false) continue;
            throw new UnauthorizedError("Your sign-in was renewed. Retry this command; its write was not replayed.");
          }
          await refuseSession(config, headers.Authorization?.slice(7));
          if (opts.statusError) throw new ApiStatusError(401, text, r.headers.get("Retry-After"));
          throw new UnauthorizedError(`${method} ${path} → 401: ${text || r.statusText}`);
        }
        if (opts.statusError) throw new ApiStatusError(r.status, text, r.headers.get("Retry-After"));
        if (r.status === 410) {
          throw new RetiredEndpointError(method, path, text);
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
        throw new RequestTimeoutError(unreachableMessage(config.apiUrl, true, `${method} ${path}`));
      }
      if (isConnectionFailure(err)) {
        throw new NetworkError(unreachableMessage(config.apiUrl, false, `${method} ${path}`));
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
    `${API_V1}/public/repos/${encodeURIComponent(rootNodeId)}`,
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
    `${API_V1}/public/repos/${encodeURIComponent(rootNodeId)}/copy-snapshot`,
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
    `${API_V1}/public/repos/${encodeURIComponent(rootNodeId)}/git?op=log&limit=${encodeURIComponent(String(limit))}`,
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
    `${API_V1}/public/repos/${encodeURIComponent(rootNodeId)}/git?op=changes&since=${encodeURIComponent(since)}`,
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

/** Pull the clean message or detail string out of an API error. */
export function apiErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const match = err.message.match(/→ \d+:\s*(.+)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]!) as { detail?: unknown; message?: unknown };
      if (typeof parsed.detail === "string") return parsed.detail;
      if (
        parsed.detail &&
        typeof parsed.detail === "object" &&
        "message" in parsed.detail &&
        typeof (parsed.detail as { message: unknown }).message === "string"
      ) {
        return (parsed.detail as { message: string }).message;
      }
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      return match[1]!;
    }
  }
  return err.message;
}

export interface CoordinationSpaceResponse {
  kind: "coordination_space";
  node_id: string;
  node_type?: "space";
  name: string;
  summary: string;
  attached_to?: string[];
  status: "active" | "dormant";
  lifecycle: "active" | "dormant";
  owner: string;
  relationship?: string | null;
  actions?: string[];
  canonical_url: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CoordinationSpaceListResponse {
  spaces: CoordinationSpaceResponse[];
  default_space_node_id?: string | null;
}

export interface ListCoordinationSpacesOptions extends RequestOptions {
  attached_to?: string;
  include_dormant?: boolean;
  limit?: number;
}

/** Fetch authorized coordination Spaces catalog. */
export async function fetchCoordinationSpaces(
  config: ApiConfig,
  opts?: ListCoordinationSpacesOptions,
): Promise<CoordinationSpaceListResponse> {
  const query = new URLSearchParams();
  if (opts?.attached_to) query.set("attached_to", opts.attached_to);
  if (opts?.include_dormant !== undefined) query.set("include_dormant", String(opts.include_dormant));
  if (opts?.limit !== undefined) query.set("limit", String(opts.limit));
  const queryString = query.toString();
  const path = `${API_V1}/coordination-spaces${queryString ? `?${queryString}` : ""}`;
  return request<CoordinationSpaceListResponse>(config, "GET", path, undefined, opts);
}

// ─── Hosted Threads (x_<id>) and Vaults ──────────────────────────────
// Raw service answers; commands/hosted-threads.ts validates and projects them.
// Each call throws ApiStatusError on a non-2xx so the verb can name the state.

const HOSTED = { statusError: true } as const;

/** GET /vaults: the person's own Vault, organization Vaults and roots shared with them. */
export async function fetchVaults(config: ApiConfig, opts?: RequestOptions): Promise<unknown> {
  return request<unknown>(config, "GET", `${API_V1}/vaults`, undefined, { ...opts, ...HOSTED });
}

/** GET /threads: hosted Threads the caller can read, newest activity first, cursor-paged. */
export async function listHostedThreads(config: ApiConfig, query: { limit: number; cursor?: string }, opts?: RequestOptions): Promise<unknown> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) params.set("cursor", query.cursor);
  const queryString = params.toString();
  const path = `${API_V1}/threads${queryString ? `?${queryString}` : ""}`;
  return request<unknown>(config, "GET", path, undefined, { ...opts, ...HOSTED });
}

/** GET /threads/{id}: the head (name, closed, last_seq, grade). No grant answers 404, like absence. */
export async function fetchHostedThread(config: ApiConfig, threadId: string, opts?: RequestOptions): Promise<unknown> {
  return request<unknown>(config, "GET", `${API_V1}/threads/${encodeURIComponent(threadId)}`, undefined, { ...opts, ...HOSTED });
}

/** GET /threads/{id}/posts: one page by seq, after_seq or before_seq, never both. */
export async function fetchHostedThreadPosts(
  config: ApiConfig, threadId: string, query: { limit: number; after_seq?: number; before_seq?: number }, opts?: RequestOptions,
): Promise<unknown> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.after_seq !== undefined) params.set("after_seq", String(query.after_seq));
  if (query.before_seq !== undefined) params.set("before_seq", String(query.before_seq));
  const queryString = params.toString();
  const path = `${API_V1}/threads/${encodeURIComponent(threadId)}/posts${queryString ? `?${queryString}` : ""}`;
  return request<unknown>(config, "GET", path, undefined, { ...opts, ...HOSTED });
}

/** POST /threads/{id}/posts: one Markdown Note as text/plain. Never retried; an exact resend is idempotent. */
export async function appendHostedThreadPost(config: ApiConfig, threadId: string, note: string, opts?: RequestOptions): Promise<unknown> {
  return request<unknown>(config, "POST", `${API_V1}/threads/${encodeURIComponent(threadId)}/posts`, note, { ...opts, ...HOSTED, text: true });
}

/** POST /threads: open a hosted Thread with its opening Note. An exact resend returns the same Thread. */
export async function openHostedThread(config: ApiConfig, note: string, recipients: string[] = [], opts?: RequestOptions): Promise<unknown> {
  return request<unknown>(config, "POST", `${API_V1}/threads`, { note, ...(recipients.length ? { recipients } : {}) }, { ...opts, ...HOSTED });
}

/** POST /threads/{id}/ack: move the caller's read cursor forward to seq (never back). */
export async function ackHostedThread(config: ApiConfig, threadId: string, seq: number, opts?: RequestOptions): Promise<unknown> {
  return request<unknown>(config, "POST", `${API_V1}/threads/${encodeURIComponent(threadId)}/ack`, { seq }, { ...opts, ...HOSTED });
}

export interface EntityDetail {
  node_id: string;
  entity_type: string;
  entity_key: string;
  name: string;
  summary: string;
  content: string;
}

/** Read one known hostname/person entity through exact Actor authorization. */
export async function fetchEntity(
  config: ApiConfig,
  entityType: "hostname" | "person",
  entityKey: string,
  opts?: RequestOptions,
): Promise<EntityDetail> {
  return request<EntityDetail>(
    config,
    "GET",
    `${API_V1}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityKey)}`,
    undefined,
    opts,
  );
}

export interface ContentTreeEntry {
  name: string;
  type: "dir" | "file";
  path: string;
  node_id: string | null;
  node_type: string | null;
  name_display: string | null;
  summary: string | null;
}

export interface ContentTreeResponse {
  kind: "content_tree";
  target_node_id: string;
  target_type: "repo" | "dir";
  root_node_id: string;
  hosted_history_available: boolean;
  path: string;
  node_id: string | null;
  name: string;
  summary: string | null;
  children: ContentTreeEntry[];
}

/** Resolve one bounded tree position under a repo-free Content coordinate. */
export async function fetchContentTree(
  config: ApiConfig,
  targetNodeId: string,
  path = "",
  opts?: RequestOptions,
): Promise<ContentTreeResponse> {
  const suffix = path
    ? `/${path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  return request<ContentTreeResponse>(
    config,
    "GET",
    `${API_V1}/content/${encodeURIComponent(targetNodeId)}/tree${suffix}`,
    undefined,
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

export interface NodeHistoryEntry {
  sha: string;
  message: string;
  date: string;
  author: string;
  op?: string;
  conversation_id?: string;
  turn?: number;
  co_authored_by?: string[];
  change_id?: string;
}

export interface NodeHistoryResponse {
  node_id?: string | null;
  path: string;
  created: string | null;
  total: number;
  history: NodeHistoryEntry[];
  authors?: Record<string, {
    kind: string;
    name?: string;
    username?: string;
  }>;
}

/**
 * Fetch a node's commit history (`GET /api/v1/repos/{id}/nodes/{nodeId}/history`).
 */
export async function fetchNodeHistory(
  config: ApiConfig,
  repoId: string,
  nodeId: string,
  opts?: RequestOptions,
): Promise<NodeHistoryResponse> {
  return request<NodeHistoryResponse>(
    config,
    "GET",
    `${API_V1}/repos/${encodeURIComponent(repoId)}/nodes/${encodeURIComponent(nodeId)}/history`,
    undefined,
    opts,
  );
}

export interface WriteFileResponse {
  path: string;
  commit_sha: string;
  node_id: string | null;
}

/** The hosted file read returns the raw note body, not rendered content. */
interface ReadFileResponse {
  path: string;
  content: string;
  last_commit_sha: string;
  node_id: string | null;
}

const NODE_PUT_TIMEOUT_MS = 120_000;
const NODE_PUT_VERIFY_TIMEOUT_MS = 15_000;

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
  const route = filesPath(repoId, path);
  try {
    // A save can outlive the generic 5-second read deadline. Do not retry a
    // PUT: aborting the client does not cancel the server's commit.
    return await request<WriteFileResponse>(config, "PUT", route, { content }, {
      ...opts,
      timeoutMs: opts?.timeoutMs ?? NODE_PUT_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof RequestTimeoutError)) throw err;
    // Check the same path with the same credentials. A match proves the
    // requested state is present (including when an earlier write was equal).
    // A mismatch/404 or failed read is inconclusive: the PUT may still be
    // committing. Never submit a second write or claim the save was lost.
    try {
      const read = await request<ReadFileResponse>(config, "GET", route, undefined, {
        timeoutMs: NODE_PUT_VERIFY_TIMEOUT_MS,
        retry: false,
      });
      if (read.content === content && read.path === path) {
        return { path: read.path, commit_sha: read.last_commit_sha, node_id: read.node_id };
      }
    } catch {
      // Verification unavailable; keep the original timeout as the cause.
    }
    throw new NetworkError(
      `Save confirmation timed out for ${path}. The server may still have saved it. ` +
      "Check the note on the server before retrying; the write was not sent again.",
    );
  }
}

// ── Sharing: recipient relationships and public visibility ──────────────────
// The data behind the Share surface. All management operations are owner-gated
// on the backend — a non-owner caller gets a 403.

export type CopyAccessLevel = "owner" | "member" | "reader" | "public";

export interface PublicationSignals {
  search: boolean;
  ai_input: boolean;
  ai_train: boolean;
}

export interface SpaceAccessResponse {
  repo_id: string;
  root_node_id: string;
  read_public: boolean;
  copy_public: boolean;
  copy_access: CopyAccessLevel;
  publication_policy: PublicationSignals;
  effective_publication_policy: PublicationSignals;
  policy_anchor_node_id: string | null;
}

export interface SpaceAccessUpdate {
  read_public: boolean;
  copy_access: CopyAccessLevel;
}

export interface NodePublicAccessResponse {
  node_id: string;
  node_type: "note" | "dir";
  read_public: boolean;
  effective_read_public: boolean;
  publication_policy: PublicationSignals;
  effective_publication_policy: PublicationSignals;
  policy_anchor_node_id: string | null;
}

export interface NodeGrant {
  id: string;
  node_id: string;
  repo_id: string | null;
  capability: string;
  grantee: string;
  granter: string;
  expires_at: string | null;
  audience?: string | null;
  audience_label?: string | null;
}

export interface NodeGrantEvent extends NodeGrant {
  grant_id: string;
  action: "created" | "deleted";
  by: string;
  at: string;
  source: string;
}

export async function getNodePublicAccess(config: ApiConfig, repoId: string, nodeId: string): Promise<NodePublicAccessResponse> {
  return request(config, "GET", `${repoBase(repoId)}/nodes/${encodeURIComponent(nodeId)}/public-access`);
}

export async function listNodeGrants(config: ApiConfig, repoId: string, nodeId: string): Promise<NodeGrant[]> {
  return request(config, "GET", `${repoBase(repoId)}/nodes/${encodeURIComponent(nodeId)}/grants`);
}

export async function listNodeGrantEvents(config: ApiConfig, repoId: string, nodeId: string): Promise<NodeGrantEvent[]> {
  return request(config, "GET", `${repoBase(repoId)}/nodes/${encodeURIComponent(nodeId)}/grant-events`);
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

export interface PersonShareHistoryResult {
  target_node_id: string;
  user_id: number;
  status: "granted" | "already_granted" | "revoked" | "not_direct";
  share_history: boolean;
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
      "This Space cannot use current sharing because its ownership record was never established. " +
      "Ask the server administrator to migrate it, or use CLI 0.1.22 while that server is upgraded."
    );
  }
  if (
    message.includes("invitation_grade_conflict") ||
    message.includes("invitation_history_conflict")
  ) {
    return (
      "A pending invitation already exists with different access or history. " +
      "Remove it with `ideaspaces share remove <email>`, then share again."
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

/** Redeliver an invitation without changing its access or history. */
export async function resendPersonShareInvite(
  config: ApiConfig,
  targetNodeId: string,
  inviteId: string,
  opts?: RequestOptions,
): Promise<PendingContentInvite> {
  return request(
    config,
    "POST",
    `${nodeBase(targetNodeId)}/person-share-invites/${encodeURIComponent(inviteId)}/resend`,
    undefined,
    opts,
  );
}

/** Toggle only hosted history for a directly shared person. */
export async function setPersonShareHistory(
  config: ApiConfig,
  targetNodeId: string,
  userId: number,
  enabled: boolean,
  opts?: RequestOptions,
): Promise<PersonShareHistoryResult> {
  return request(
    config,
    enabled ? "PUT" : "DELETE",
    `${nodeBase(targetNodeId)}/person-shares/${encodeURIComponent(String(userId))}/history`,
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

export interface AccessRequestCreateBody {
  grade?: "explore" | "fork" | "collaborate";
  reason?: string;
}

export interface AccessRequestResponse {
  id: string;
  target_node_id: string;
  requested_grade: "explore" | "fork" | "collaborate";
  reason?: string | null;
  state: "pending" | "expired" | "cancelled" | "denied" | "approved";
  expires_at: string;
  created_at: string;
  cancelled_at?: string | null;
  denied_at?: string | null;
  approved_at?: string | null;
  approved_grade?: "explore" | "fork" | "collaborate" | null;
}

export interface IncomingAccessRequestResponse extends AccessRequestResponse {
  requester: string;
  position: number;
}

export interface AccessRequestDecisionResponse extends AccessRequestResponse {
  changed: boolean;
}

export async function createAccessRequest(
  config: ApiConfig,
  targetNodeId: string,
  body: AccessRequestCreateBody,
  opts?: RequestOptions,
): Promise<AccessRequestResponse> {
  return request<AccessRequestResponse>(
    config,
    "POST",
    `${API_V1}/nodes/${encodeURIComponent(targetNodeId)}/access-requests`,
    body,
    opts,
  );
}

export async function listAccessRequests(
  config: ApiConfig,
  options?: { includeTerminal?: boolean; limit?: number },
  opts?: RequestOptions,
): Promise<{ requests: AccessRequestResponse[] }> {
  const query = new URLSearchParams();
  if (options?.includeTerminal) query.set("include_terminal", "true");
  if (options?.limit) query.set("limit", String(options.limit));
  const queryString = query.toString() ? `?${query.toString()}` : "";
  return request<{ requests: AccessRequestResponse[] }>(
    config,
    "GET",
    `${API_V1}/access-requests${queryString}`,
    undefined,
    opts,
  );
}

export async function listIncomingAccessRequests(
  config: ApiConfig,
  options?: { limit?: number },
  opts?: RequestOptions,
): Promise<{ requests: IncomingAccessRequestResponse[] }> {
  const query = new URLSearchParams();
  if (options?.limit) query.set("limit", String(options.limit));
  const queryString = query.toString() ? `?${query.toString()}` : "";
  return request<{ requests: IncomingAccessRequestResponse[] }>(
    config,
    "GET",
    `${API_V1}/access-requests/incoming${queryString}`,
    undefined,
    opts,
  );
}

export async function getAccessRequest(
  config: ApiConfig,
  requestId: string,
  opts?: RequestOptions,
): Promise<AccessRequestResponse> {
  return request<AccessRequestResponse>(
    config,
    "GET",
    `${API_V1}/access-requests/${encodeURIComponent(requestId)}`,
    undefined,
    opts,
  );
}

export async function approveAccessRequest(
  config: ApiConfig,
  requestId: string,
  body?: { grade?: "explore" | "fork" | "collaborate" },
  opts?: RequestOptions,
): Promise<AccessRequestDecisionResponse> {
  return request<AccessRequestDecisionResponse>(
    config,
    "POST",
    `${API_V1}/access-requests/${encodeURIComponent(requestId)}/approve`,
    body ?? {},
    opts,
  );
}

export async function denyAccessRequest(
  config: ApiConfig,
  requestId: string,
  opts?: RequestOptions,
): Promise<AccessRequestDecisionResponse> {
  return request<AccessRequestDecisionResponse>(
    config,
    "POST",
    `${API_V1}/access-requests/${encodeURIComponent(requestId)}/deny`,
    undefined,
    opts,
  );
}

export async function cancelAccessRequest(
  config: ApiConfig,
  requestId: string,
  opts?: RequestOptions,
): Promise<AccessRequestResponse> {
  return request<AccessRequestResponse>(
    config,
    "POST",
    `${API_V1}/access-requests/${encodeURIComponent(requestId)}/cancel`,
    undefined,
    opts,
  );
}

export async function getSpaceAccess(
  config: ApiConfig,
  repoId: string,
): Promise<SpaceAccessResponse> {
  return request<SpaceAccessResponse>(config, "GET", `${repoBase(repoId)}/access`);
}

export async function setSpaceAccess(
  config: ApiConfig,
  repoId: string,
  update: SpaceAccessUpdate,
  opts?: RequestOptions,
): Promise<SpaceAccessResponse> {
  // A cold server can take longer than the normal request budget. Never retry a visibility write:
  // after a timeout the server may already have applied it.
  return request<SpaceAccessResponse>(config, "PATCH", `${repoBase(repoId)}/access`, update, {
    timeoutMs: 30_000,
    ...opts,
    retry: false,
  });
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  kind?: "command" | "command-output";
  command?: string;
  args?: string;
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
  const headers = await authHeaders(config, { Accept: "text/event-stream" });
  const r = await fetch(`${config.apiUrl}${path}`, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (r.status === 401) {
      if (config.sessionId) {
        await renewRefusedAccess(config, headers.Authorization?.slice(7));
        throw new UnauthorizedError("Your sign-in was renewed. Retry this command; the streamed write was not replayed.");
      }
      await refuseSession(config, headers.Authorization?.slice(7));
      throw new UnauthorizedError(`POST ${path} → 401: ${text || r.statusText}`);
    }
    if (r.status === 410) throw new RetiredEndpointError("POST", path, text);
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

/** A hosted Space is a named Map, not a Repo or a local folder. */
export interface HostedSpaceSummary {
  node_id: string;
  name: string;
  summary: string;
  head_version_id: string | null;
  owner: string;
}

export interface HostedSpaceRead {
  map_id: string;
  version_id: string;
  ordinal: number;
  authored: { label: string; summary: string | null; legend_markdown: string | null };
  status: string;
  counts: Record<string, number>;
  roots: unknown[];
  members: Array<{
    address: { ordinal: number; address?: string | null; position_at_pin?: string | null;
      authored_name?: string | null; authored_summary?: string | null; representation: string };
    state: string;
  }> | null;
  omitted_members: number;
}

export async function fetchHostedSpaces(config: ApiConfig): Promise<{ maps: HostedSpaceSummary[] }> {
  const result = await request<{ maps: HostedSpaceSummary[] }>(config, "GET", `${API_V1}/maps`);
  if (!result || !Array.isArray(result.maps) || result.maps.some(m => !m || typeof m.node_id !== "string" || typeof m.name !== "string" || typeof m.owner !== "string")) {
    throw new Error("IdeaSpaces returned an unreadable Spaces list. Retry, or update the CLI.");
  }
  return result;
}

export async function fetchHostedSpace(config: ApiConfig, id: string): Promise<HostedSpaceRead> {
  const result = await request<HostedSpaceRead>(config, "GET", `${API_V1}/maps/${encodeURIComponent(id)}?detail=members`);
  if (!result || typeof result.map_id !== "string" || typeof result.version_id !== "string" ||
      !result.authored || typeof result.authored.label !== "string" ||
      !Number.isSafeInteger(result.omitted_members) || result.omitted_members < 0 ||
      (result.members !== null && (!Array.isArray(result.members) || result.members.some(m => !m?.address || !Number.isInteger(m.address.ordinal) || typeof m.state !== "string")))) {
    throw new Error("IdeaSpaces returned an unreadable Space. Retry, or update the CLI.");
  }
  return result;
}
