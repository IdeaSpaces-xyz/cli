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
ideaspaces create my-space --yes    # create the standard repository shape
cd my-space
ideaspaces navigate .               # orient: what's here, what changed
ideaspaces inspect work/Next.md      # deepen one document, summary first
ideaspaces write decisions/idea.md --content "Idea body text"
ideaspaces commit -m "Capture idea" decisions/idea.md

# Optional: host or collaborate remotely
ideaspaces login
ideaspaces publish
ideaspaces push
ideaspaces pull
```

Everything is local-first: your working copy is a real git repository on disk. Captures are yours until you choose to publish or push them.

## Commands

Run `ideaspaces <command> --help` for full usage. `--json` is available on most read commands for scripting.

### Spaces & content
| Command | What it does |
|---|---|
| `clone <space-url> [dir]` | Clone an authorized Space by stable identity into a local working copy |
| `fork <space-url> [dir]` | Create and clone an independent current-content copy without source history |
| `clones` | List your local working copies |
| `create <name>` | Create a new space |
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
| `push` | Send your committed captures to the remote |
| `pull` | Integrate remote changes into your local copy |
| `publish` | Publish a local space to the server |

### Navigate & search
| Command | What it does |
|---|---|
| `navigate <path>` | Orient at a position — contract, awareness, what changed |
| `inspect <path>` | Inspect one local Markdown file by summary, outline, or selected section |
| `catalog` | List the nodes at a position |
| `ls [<path>]` | List files and folders under a path, typed (folder / repo / ideaspace) |
| `search <query>` | Full-text search (filename + BM25) over the local clone |
| `status` | Working-copy status (ahead / behind / dirty) |
| `skills` | List the skill catalog, or print one skill's markdown |

### Collaborate
| Command | What it does |
|---|---|
| `conversation` | Start or continue a conversation (online or `--local`) |
| `conversations` | List conversations |
| `share` | Manage members, invites, and public links |
| `agents` | List agents available to you |
| `times` | Activity timeline |

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
| `conversation send --local` | Run a local agent turn over a folder |

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
