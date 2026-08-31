# IdeaSpaces CLI

> Capture durable agent knowledge from the command line.

The [Ideaspace Protocol](https://github.com/IdeaSpaces-xyz/ideaspace-protocol) is the open standard for how agents turn useful work into durable, portable knowledge. `ideaspaces` implements the common command-line mechanics: create and orient in a space, write and commit captures safely, then optionally publish, push, or pull.

A **space** is a git repository where knowledge compounds as ordinary Markdown. The CLI keeps the workflow local-first and scriptable; protocol-aware plugins use the protocol directly for local reads and rely on CLI capabilities for platform operations and transitional writes.

Want your agent to follow the standard automatically? Install [IdeaSpaces for Claude Code and Cowork](https://github.com/IdeaSpaces-xyz/claude-code-plugin) or [IdeaSpaces for Pi](https://github.com/IdeaSpaces-xyz/pi-is-space). Use this package directly for terminal workflows, automation, and integration development.

## Install

```sh
npm install -g @ideaspaces/cli
```

This installs the `ideaspaces` command. Node 20+ is required.

## Quick start

```sh
ideaspaces doctor                   # check Node, Git, and optional remote auth
ideaspaces create my-space --yes    # create the standard repository shape
cd my-space
ideaspaces navigate .               # orient: what's here, what changed
ideaspaces inspect work/Next.md      # deepen one document, summary first
ideaspaces write decisions/idea.md --content "Idea body text"
ideaspaces commit -m "Capture idea" decisions/idea.md

# Or take a public, copy-enabled Space home without an account or source history
ideaspaces fork https://ideaspaces.xyz/spaces/<root_node_id> ./my-fork

# Optional: host or collaborate remotely
ideaspaces login
ideaspaces publish
ideaspaces push
ideaspaces pull
```

Everything is local-first: your working copy is a real git repository on disk. Captures are yours
until you choose to publish or push them. Shared `create` mints a portable `root_node_id` into the
committed root foundation before login; private gitignored `_agent/` scaffolds remain unstamped.
First `publish` asks the server to adopt that exact committed identity. Declaration,
canonical-origin, or registry drift refuses before network mutation, and `publish --force` never
forks or rekeys a Space. `fork` is also local-first: it reads one bounded, copy-authorized snapshot,
validates it before touching the destination, and creates an unpublished one-commit Space with fresh
identity and no remote. Public View + Fork needs no account; signing in is required only when a
private source was shared directly or when the local fork is later published. `update` keeps that
relationship account-free while both public permissions remain enabled. It previews before apply,
validates the complete Markdown plus exact `_assets/` snapshot, and uses a three-way plan that
preserves local work and reports conflicts; directly shared private sources still use ambient auth.

`status` reports the local root-identity state and its HEAD/index/worktree declaration facts without
network access or mutation. `write` operates only inside that canonical Git worktree. It preserves
frontmatter fields you do not
set, replaces the Markdown atomically, and stages only the selected path. Use the returned `sha` as
`--if-match` for a safe refinement; `--force` is the explicit destructive override. `commit` snapshots
the worktree/index/HEAD revision of every selected path and commits exactly that reviewed set, leaving
bystander work untouched. Commit identity comes from Git's effective `user.name` / `user.email`
(preferably wired repo-locally by creation and platform commands) or explicit `--author-name` /
`--author-email` flags—never a hidden credential or network lookup. With `--json`, both commands return protocol `status`, phase, revision,
and typed failure facts; a partial write or commit exits non-zero.

## Commands

Run `ideaspaces <command> --help` for full usage. `--json` is available on reads and local capture effects for scripting.

### Diagnostics
| Command | What it does |
|---|---|
| `doctor` | Check Node 20+, Git, and optional remote-auth readiness; use `--json` for stable machine output |

### Spaces & content
| Command | What it does |
|---|---|
| `clone <space-url> [dir]` | Clone an authorized Space, preserve its declaration, and verify it against the canonical origin |
| `fork <space-url> [dir]` | Materialize an independent unpublished Space without source history or an account |
| `update [--yes]` | Preview or apply account-optional three-way source updates without displacing local work |
| `clones` | List hosted clones and unpublished local forks |
| `create <name>` | Create a local Space; shared scaffolds mint portable root identity before login |
| `repos` | List spaces you can access |
| `link <dir> <namespace/slug>` | Bind an existing local directory to a space |

### Editing & capture
| Command | What it does |
|---|---|
| `write <path>` | Create or edit a note |
| `node <path>` | Read a single node (file) with its metadata |
| `change` | Open a mutable capture (a tracked change set) |
| `commit` | Commit captured changes with attribution trailers |

### Sync & publish
| Command | What it does |
|---|---|
| `sync` | Report where you, the Space, and a fork's recorded source stand — reads only, integrates nothing |
| `push` | Send your committed captures to the remote |
| `pull` | Integrate changes from the fork's own Git remote |
| `publish` | Adopt the committed local identity on first publish; never silently rebind or rekey |

### Navigate & search
| Command | What it does |
|---|---|
| `navigate <path>` | Orient at a position — contract, awareness, what changed |
| `inspect <path>` | Inspect one local Markdown file by summary, outline, or selected section |
| `catalog` | Join local checkouts with remote Spaces and their publication/sync state |
| `ls [<path>]` | List files and folders under a path, typed (folder / repo / ideaspace) |
| `search <query>` | Full-text search (filename + BM25) over the local clone |
| `status` | Working-copy and offline root-identity status, including uncommitted declaration drift |
| `skills` | List the skill catalog, or print one skill's markdown |

### Collaborate
| Command | What it does |
|---|---|
| `conversation` | Start or continue a conversation (online or `--local`) |
| `conversations` | List conversations |
| `share` | Share a Space at a grade — explore, fork, or collaborate — and see who has it |
| `inbox` | Ask, read, and reply through direct exchanges about shared Content |
| `agents` | List agents available to you |
| `times` | Activity timeline |

Share addresses people and teams by names rather than internal ids:

```bash
ideaspaces share person someone@example.com --grade explore
ideaspaces share person @someone --grade fork
ideaspaces share team acme.com --grade collaborate
ideaspaces share list
ideaspaces share remove team:acme.com
ideaspaces share visibility public   # anyone can view and fork locally; publishing still requires sign-in
ideaspaces share visibility private  # named access is unchanged

# Ask the owner of shared Content from a local agent or terminal
ideaspaces inbox send @owner --about n_0123456789abcdef01234567 \
  --name "Question" --summary "One decision" --message "What should happen next?"
ideaspaces inbox list
ideaspaces inbox read x_example
printf '# Answer\n\nKeep it narrow.' | ideaspaces inbox reply x_example \
  --name "Answer" --summary "A bounded answer"
```

Inbox commands act as the logged-in person. Bare Agent credentials cannot read or write a person's
Inbox; plugins expose these person-accountable commands to a local agent after the person logs in.
Every exchange remains attached to the exact Content `node_id` it concerns.

Public visibility permits a bounded, history-free local Fork; it never makes Git history, clone, or
push public and never creates an anonymous hosted owner.

### Identity
| Command | What it does |
|---|---|
| `login` | Authenticate and store credentials |
| `whoami` | Show the current identity |
| `forget` | Remove stored credentials |
| `power logout` | Log out and clear stored credentials |
| `credential` | Git credential helper (used by git under the hood) |

### Local agent (Pi)
Run an agent over your local working copy — offline, on your own key.
| Command | What it does |
|---|---|
| `pi-status` | Is a local agent runtime available and configured? |
| `pi-login` | Configure a model provider (writes the local agent's credentials) |
| `pi-logout` | Remove a configured model provider |
| `pi-models` | List the models a configured provider offers |
| `conversation send --local` | Run a local agent turn over a folder; add `--map <map-note.md>` to launch over its ordered territory without fetching its roots |

A local Map launch reads the provisional `map:` frontmatter from the selected Note, validates it through the protocol, and appends its roots, pins, ordered members, representation depths, and legend to Pi's launch orientation. Invalid Maps fail before Pi starts; omitting `--map` preserves the folder-only launch.

## Configuration

| Path | What |
|---|---|
| `~/.ideaspaces/credentials.json` | Your API credentials |
| `~/.ideaspaces/spaces.json` | Known spaces and their remotes |
| `~/.pi/agent/auth.json` | Local-agent model-provider credentials |

### Environment variables
| Variable | What |
|---|---|
| `IS_API_KEY` | API key (overrides stored credentials) |
| `IS_API_URL` | API base URL (defaults to the hosted service) |
| `IDEASPACES_PI_EXTENSIONS` | Comma-separated extension paths for the local agent |

## License

MIT
