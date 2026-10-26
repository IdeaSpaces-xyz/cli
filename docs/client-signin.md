# Per-install CLI sign-in: proof and rollout

## Local proof

2026-10-26, against sw_space `4b9bc02c` (merged Desktop sign-in routes). No production
account, installed credentials/settings, provider auth files, native apps or model calls.

From a built CLI checkout, with a scratch HOME:

```sh
node scripts/client-signin-check.mjs --sw-space /path/to/sw_space --python /path/to/venv/bin/python
```

The opt-in runner requires the selected server checkout's Python dependencies. It disables
server env-file loading, starts loopback-only uvicorn with a fresh SQLite database and a
synthetic One user/web session, and cleans up its temporary state. Only the external Google
token/userinfo boundary is faked, following the server's own test pattern. No production
OAuth provider or external browser is contacted. The native browser opener is a disposable
Unix stub; the driver follows the real local authorize/provider-state/cookie/callback routes.
The generated web-session cookie travels over a private pipe, never argv/logs.

The runner invokes the **built bundle's actual** `login`, `status account`, `credential get`
and `power logout`, one process at a time. It proves:

- authorization uses `client=cli`, state, S256 PKCE, loopback and a stable per-service install;
- the resulting session appears as a separate `cli` entry in the web settings API;
- setting only the fixture's client-side expiry to now causes a real server refresh before
  the next status/API call, rotating both tokens;
- the Git helper also refreshes before supplying its password over Git's private protocol;
- replay of the consumed refresh returns invalid_grant and revokes the entire family;
- revoking the entry through the web-session route signs the CLI out on its next status call;
- a later login reuses this install identity; CLI logout revokes on the server and deletes
  local credentials, with no live entry left in web settings.

The proof asserts only public projections/booleans in stdout; it never prints tokens. It
checks the account settings API, not a rendered web settings screen. Unit tests additionally
cover callback tampering/early arrival/timeout/refusal, explicit legacy/env keys, service
binding, rotation serialization, crash/lost-response markers, malformed token responses,
streaming, late 401s, preserving a newer login and offline sign-out retention.

## Consumer parity and publication gate

No protocol or SDK shape changed. This is CLI client authentication, not agent authority or
Desktop keychain work. No new person-key minting or legacy-start fallback is introduced.

| Consumer | Exposure and remaining rollout |
|---|---|
| MCP server | Existing is_auth dispatch shells `login` / `power logout`; no new native tool needed. Its duplicate credentials module is not referenced by live tool code. Pick up the new CLI in its normal released/bundled route after publication approval. |
| Skills | Command names stay valid, but a credentials-file presence check is not an online sign-in check. Before consumer rollout, replace such guidance with `status account --json`; explain that logout revokes a session and that offline failure keeps local state. |
| Pi integration | Existing is_auth also shells `login` / `power logout`. Keep its current pin unchanged until the approved CLI publication, then update its pin/version and affected auth guidance with that integration's next change. |
| Claude Code plugin | Requires reproducible CLI re-vendoring and its own version bump when the human opens the batch. No hand-edited bundle or silent update under an existing plugin version. Update presence-only auth guidance in that batch. |

This PR deliberately does **not** publish a CLI version, change consumer pins, or open a plugin
batch. The bundled consumers must update before they can renew a new session or perform its
server sign-out; old bundles understand only the access field. Existing legacy API keys keep
working. Do not close fresh legacy server starts until the approved CLI publication and its
coordinated rollout. The coordinating delivery records this as a publication/consumer gate,
not as already delivered to installed users.
