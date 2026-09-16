# IdeaSpaces CLI

> The command line for folders that agents inhabit.

An ideaspace is a folder of Markdown under git that holds **your knowledge** and **how to work with it**. Open an agent inside it and that's who you're talking to. The [protocol](https://github.com/IdeaSpaces-xyz/ideaspace-protocol) defines the shape.

Most people use the shape through a plugin for [Claude Code, Codex, or Cowork](https://github.com/IdeaSpaces-xyz/claude-code-plugin), or [Pi](https://github.com/IdeaSpaces-xyz/pi-is-space). The plugins bundle this CLI. Install it yourself for scripts, automation, and other harnesses.

A space is a real git repository on your disk. Nothing leaves your machine until you publish or push.

## Install

```sh
npm install -g @ideaspaces/cli
```

Node 20+ and git. `ideaspaces doctor` checks both.

## Five minutes

```sh
ideaspaces create my-space --yes       # a folder with _agent/ in it, committed
cd my-space
ideaspaces navigate .                  # what is here, what changed since last time
ideaspaces look . --depth children       # one target at a chosen rung
ideaspaces write decisions/pricing.md --name "Pricing" --content "# Pricing

Per seat, billed yearly."
ideaspaces commit -m "Capture the pricing decision" decisions/pricing.md
```

`create` still writes the Foundation compatibility scaffold. To try the Agreement convention, add `_agent/agreement.md`; `navigate` then prefers Agreement when both exist and loads it in full. Use `navigate --contract foundation` for an explicit comparison. Ambient navigation renders the protocol-owned stable `head`, then local working-set/catalog handles, then the volatile `tail`; activity belongs only to the tail. `look <path> --depth name|summary|surface|children|full` reads exactly one local Note or directory beneath a reference-only frame; the existing `navigate --focus` and `inspect` readers remain available during convergence. `create --agent` makes a folder that *is* an agent. Inside a code repo, `create --yes` keeps `_agent/` local to your machine; `--shared` commits it.

## Take one home, hand one over

```sh
git clone https://github.com/IdeaSpaces-xyz/hn-reader && cd hn-reader    # any git host
ideaspaces fork https://ideaspaces.xyz/repos/<repo-id> ./theirs         # public space, no account
ideaspaces update --yes                                                   # later: pull in source changes that don't conflict
```

```sh
ideaspaces login
ideaspaces publish --yes                                     # host it, private to you
ideaspaces share person someone@example.com --grade explore
ideaspaces share visibility public --yes                     # anyone can view and fork
ideaspaces push
ideaspaces pull
```

Anything that leaves your machine prints its plan and runs only with `--yes`.

`share` stays recipient-shaped: `person`, `team`, `list`, `remove`, `resend`, `history`, and
`visibility`. It does not expose repository memberships, internal Grant records, or organization
administration.

## Commands

`ideaspaces <command> --help` for usage. `--json` on reads and local writes.

| Job | Commands |
|---|---|
| Look around | `navigate`, `look`, `status`, `inspect`, `ls`, `search`, `skills`, `map`, `times` |
| Write things down | `write`, `commit`, `change`, `node` |
| Start, clone, fork | `create`, `clone`, `fork`, `update`, `clones`, `link`, `forget` |
| Share and sync | `login`, `status account` (`whoami`), `publish`, `share`, `push`, `pull`, `sync`, `repos`, `catalog` |
| Talk | `conversation`, `conversations`, `inbox`, `agents` |
| Run a local agent | `pi-status`, `pi-login`, `pi-logout`, `pi-models`, `conversation send --local` (`--runtime=pi`, the default, or `--runtime=claude` for your own Claude Code) |
| Housekeeping | `status doctor` (`doctor`), `credential`, `power logout` |

## What the CLI promises

- **`write`** touches only the file you name and keeps frontmatter you did not set. Pass the returned `sha` as `--if-match` for a safe second write; `--force` overwrites.
- **`commit`** commits only the paths you name. Other staged work, yours or a teammate's, is left alone. The author is git's `user.name` and `user.email`, never a hidden credential.
- **A space has one id.** Agreement is the preferred contract source; until it declares identity, a valid Foundation identity remains the compatibility evidence for that same Space. Legacy `create` still writes Foundation, `publish` adopts its identity, and conflicting declarations fail closed. `clone` keeps identity; `fork` remints it in every projected root entrypoint. Nothing rekeys a space silently.
- **`status` is the tail, and only the tail.** It renders local State (branch, upstream, working tree, captures awaiting commit), the repo catalog when you pass `--workspace`, and what moved since last session — the same composition an agent runtime appends after its cached head, so the two never disagree. Nothing `navigate` already showed in the head. Login state and installation health are separate sections: `status account` and `status doctor` (`whoami` and `doctor` still work for one release).
- **`look` deepens one target without adopting its terms.** The applicable Agreement or Foundation is reference context only. JSON adds a portable `map` only for a clean, pinned, identified root; dirty, unborn, ignored, local-only, or invalid roots remain honest local projections.
- **`map` distinguishes local projection from portable selection.** Tree names and summaries use the protocol Map-member shape, but JSON includes a portable `map` block only for a clean, exactly pinned root with stable identity that passes strict protocol validation. Dirty, unborn, unidentified, or invalid trees remain inspectable under `projection` without leaking their checkout path into a Map.
- **`fork` and `update`** validate before touching your disk and never overwrite your work; conflicts are reported.
- **`--json`** returns a `status`, the revision, and typed failure details. A partial write or commit exits non-zero.
- **`conversation send --local --runtime=claude`** runs Claude Code — the copy you installed and signed in to, unmodified. Usage bills to your own Claude plan (or to your API key with `--claude-auth=api-key` — without it, a stray `ANTHROPIC_API_KEY` in your shell is kept away from the turn; provider routing you configured yourself, such as Bedrock or Vertex, stays in force); the CLI never sees your credentials and reads only the session transcripts Claude Code writes under `~/.claude/projects/`. A turn streams the same events as a pi or hosted turn, so every client renders it the same way.

## Which local runtime

Both stream the same transcript; they differ in whose agent runs and how it is paid for.

| | `--runtime=pi` (default) | `--runtime=claude` |
|---|---|---|
| What runs | pi, bundled with the desktop or `pi` on your PATH | the Claude Code you installed and signed in to |
| Who pays | your API key for the provider you chose (`pi-login`) | your Claude plan, or your API key with `--claude-auth=api-key` |
| Models | any provider pi supports | Anthropic |
| Agent context | our extensions and skills, passed with `--ext` and `--skill` | whatever your Claude Code already carries — plugin, skills, `_agent/`, memory |
| Where sessions live | `<context>/.pi/sessions/`, inside the space | `~/.claude/projects/`, outside the space |
| Reasoning in the transcript | shown | not shown — Claude Code redacts it when run headless |
| Needs a Claude account | no | yes |

Pick `claude` to continue a session you started in Claude Code; the same session id resumes it. Close it there first — one session should have one writer at a time. Pick `pi` for another provider, an API-key setup, or a machine without Claude Code.

## Configuration

| Path | What |
|---|---|
| `~/.ideaspaces/credentials.json` | API credentials |
| `~/.ideaspaces/spaces.json` | Known spaces and remotes |
| `~/.pi/agent/auth.json` | Local-agent model credentials |

`IS_API_KEY` overrides stored credentials. `IS_API_URL` points at another host. `IDEASPACES_PI_EXTENSIONS` lists extension paths for the local agent. `CLAUDE_CONFIG_DIR` relocates the Claude Code sessions `--runtime=claude` reads, as it does for Claude Code itself.

## Contributing

Every server operation the CLI performs is listed in [`contract/api-calls.json`](contract/api-calls.json), generated from `src/auth/api.ts` by `npm run api:inventory`; a test fails when the source changes without it. `npm run check:api -- <openapi.json>` holds that inventory against a server's OpenAPI document and fails on any operation the server does not serve or marks deprecated. The document is an input — set `IDEASPACES_OPENAPI=<path>` to run the same check inside `npm test`.

## License

MIT
