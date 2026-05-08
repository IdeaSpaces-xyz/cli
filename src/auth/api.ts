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

async function request<T>(config: ApiConfig, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as T;
}

/** Fetch the OAuth-resolved identity. Authenticates the stored credentials. */
export async function fetchAuthMe(config: ApiConfig): Promise<AuthMeResponse> {
  return request<AuthMeResponse>(config, "GET", "/auth/me");
}

/** Create a server-side bare repo. Returns repo_id + slug + name.
 *
 * The server creates the repo with no refs and no scaffold — first push
 * from the client establishes refs/heads/main. Pre-receive's force-push
 * guard short-circuits on ZERO_OID for ref creation.
 */
export async function createRepo(config: ApiConfig, body: CreateRepoBody): Promise<CreateRepoResult> {
  return request<CreateRepoResult>(config, "POST", `${API_V1}/repos`, body);
}
