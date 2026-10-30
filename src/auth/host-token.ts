/**
 * The host-run token: under IDEASPACES_AUTH=host, the only credential this CLI
 * spends. An app that holds its own sign-in (Idea Explorer) opens a pipe on an
 * inherited descriptor, passes its number as `--token-fd <n>`, writes one line
 * `{"api_url": "...", "access_token": "..."}` and closes its end.
 *
 * The CLI reads that descriptor once, to EOF, before any command runs, then
 * closes it, so no child (git, a shell) can inherit it. The token lives only in
 * this process's memory: it is never written, logged, refreshed, put in argv or
 * env, or echoed in an error. Node also marks inherited handles noninheritable
 * at startup; closing the descriptor does not rely on that.
 */

import { closeSync, readSync } from "node:fs";

const MAX_BYTES = 8 * 1024;
const READ_DEADLINE_MS = 5_000;

export interface HostToken { apiUrl: string; accessToken: string }

let held: HostToken | null = null;

export class HostTokenError extends Error {
  readonly code = "HOST_TOKEN";
  constructor(message: string) {
    super(message);
    this.name = "HostTokenError";
  }
}

/** HTTPS, or loopback HTTP for local testing; an origin with no path, query or credentials. */
export function hostServiceOrigin(raw: unknown): string {
  if (typeof raw !== "string") throw new HostTokenError("The host token's api_url is missing.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new HostTokenError("The host token's api_url is not a URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname)
    || !(url.protocol === "https:" || url.protocol === "http:" && loopback)) {
    throw new HostTokenError("The host token's api_url must be an HTTPS service origin (loopback HTTP for testing).");
  }
  return url.origin;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read `{api_url, access_token}` from an inherited descriptor, once, then close it.
 * Errors never include what was read.
 */
export function readHostToken(fd: number): HostToken {
  if (held) throw new HostTokenError("The host token was already read; --token-fd is read once.");
  if (!Number.isSafeInteger(fd) || fd < 3) throw new HostTokenError("--token-fd needs an inherited descriptor number of 3 or more.");
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    for (;;) {
      const buffer = Buffer.alloc(1024);
      let n: number;
      try { n = readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An inherited pipe can arrive nonblocking; wait for the host's write, within a deadline.
        if (code === "EAGAIN" && Date.now() < deadline) { sleep(5); continue; }
        if (code === "EAGAIN") throw new HostTokenError(`--token-fd ${fd} sent nothing within ${READ_DEADLINE_MS / 1000} s; the host must write the token and close its end.`);
        if (code === "EBADF") throw new HostTokenError(`--token-fd ${fd} is not an open descriptor in this process.`);
        throw new HostTokenError(`--token-fd ${fd} could not be read (${code ?? "unknown error"}).`);
      }
      if (n === 0) break;
      total += n;
      if (total > MAX_BYTES) throw new HostTokenError(`--token-fd ${fd} sent more than ${MAX_BYTES} bytes; expected one {api_url, access_token} line.`);
      chunks.push(buffer.subarray(0, n));
    }
  } finally {
    try { closeSync(fd); } catch { /* already closed or never open; nothing to inherit */ }
  }
  let parsed: unknown;
  // JSON.parse's message can quote the input; never let it reach output.
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HostTokenError(`--token-fd ${fd} did not send JSON; expected {"api_url": "...", "access_token": "..."}.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HostTokenError(`--token-fd ${fd} must send one JSON object with api_url and access_token.`);
  const { api_url, access_token } = parsed as Record<string, unknown>;
  const apiUrl = hostServiceOrigin(api_url);
  if (typeof access_token !== "string" || !access_token || access_token.length > 4096 || /[\s\p{Cc}]/u.test(access_token)) {
    throw new HostTokenError("The host token's access_token is missing or malformed.");
  }
  held = { apiUrl, accessToken: access_token };
  return held;
}

/** The token read from --token-fd in this process, or null. */
export function hostToken(): HostToken | null {
  return held;
}

/** Tests only: forget the token between cases. */
export function forgetHostToken(): void {
  held = null;
}
