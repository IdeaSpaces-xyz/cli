# ideaspaces

> Persistent, searchable knowledge from the command line.

`ideaspaces` is the CLI for [IdeaSpaces](https://ideaspaces.xyz) — a place where teams of people and agents maintain shared understanding. A **space** is a git repository where knowledge compounds: notes are state, conversations are process, and the directory tree is how you navigate. This CLI is the fastest way to work with a space: clone it locally, edit and capture, search, sync, and talk to an agent — online or fully local.

## Install

```sh
npm install -g @ideaspaces/cli
```

This installs the `ideaspaces` command. Node 20+ is required.

## Quick start

```sh
ideaspaces login                 # authenticate
ideaspaces clone alice/notes     # clone a space to a local working copy
cd notes
ideaspaces navigate .            # orient: what's here, what changed
ideaspaces write ideas.md        # edit a note
ideaspaces sync                  # push local edits, pull remote changes
```

Everything is local-first: your working copy is a real git clone on disk. Edits are yours until you `sync`.

## Commands

Run `ideaspaces <command> --help` for full usage. `--json` is available on most read commands for scripting.

### Spaces & content
| Command | What it does |
|---|---|
| `clone <namespace/slug> [dir]` | Clone a space into a local working copy |
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
| `sync` | Push local edits and pull remote changes |
| `push` / `pull` | One-directional sync |
| `publish` | Publish a local space to the server |

### Navigate & search
| Command | What it does |
|---|---|
| `navigate <path>` | Orient at a position — contract, awareness, what changed |
| `catalog` | List the nodes at a position |
| `search <query>` | Semantic + keyword search across a space |
| `status` | Working-copy status (ahead / behind / dirty) |

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
| `credential` | Git credential helper (used by git under the hood) |

### Local agent (Pi)
Run an agent over your local working copy — offline, on your own key.
| Command | What it does |
|---|---|
| `pi-status` | Is a local agent runtime available and configured? |
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
