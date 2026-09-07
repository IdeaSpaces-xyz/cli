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
ideaspaces inspect _agent/guide.md     # one document, summary first
ideaspaces write decisions/pricing.md --name "Pricing" --content "# Pricing

Per seat, billed yearly."
ideaspaces commit -m "Capture the pricing decision" decisions/pricing.md
```

`navigate` will say that `purpose.md` and `now.md` are not written yet. That is the folder asking for its direction. `create --agent` makes a folder that *is* an agent. Inside a code repo, `create --yes` keeps `_agent/` local to your machine; `--shared` commits it.

## Take one home, hand one over

```sh
git clone https://github.com/IdeaSpaces-xyz/hn-reader && cd hn-reader    # any git host
ideaspaces fork https://ideaspaces.xyz/spaces/<space-id> ./theirs         # public space, no account
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
| Look around | `navigate`, `inspect`, `ls`, `search`, `skills`, `status`, `map`, `times` |
| Write things down | `write`, `commit`, `change`, `node` |
| Start, clone, fork | `create`, `clone`, `fork`, `update`, `clones`, `link`, `forget` |
| Share and sync | `login`, `whoami`, `publish`, `share`, `push`, `pull`, `sync`, `repos`, `catalog` |
| Talk | `conversation`, `conversations`, `inbox`, `agents` |
| Run a local agent | `pi-status`, `pi-login`, `pi-logout`, `pi-models`, `conversation send --local` |
| Housekeeping | `doctor`, `credential`, `power logout` |

## What the CLI promises

- **`write`** touches only the file you name and keeps frontmatter you did not set. Pass the returned `sha` as `--if-match` for a safe second write; `--force` overwrites.
- **`commit`** commits only the paths you name. Other staged work, yours or a teammate's, is left alone. The author is git's `user.name` and `user.email`, never a hidden credential.
- **A space has one id**, written by `create` into `_agent/foundation.md`. `publish` adopts it and refuses a mismatch. `clone` keeps it; `fork` mints a new one. Nothing rekeys a space silently.
- **`fork` and `update`** validate before touching your disk and never overwrite your work; conflicts are reported.
- **`--json`** returns a `status`, the revision, and typed failure details. A partial write or commit exits non-zero.

## Configuration

| Path | What |
|---|---|
| `~/.ideaspaces/credentials.json` | API credentials |
| `~/.ideaspaces/spaces.json` | Known spaces and remotes |
| `~/.pi/agent/auth.json` | Local-agent model credentials |

`IS_API_KEY` overrides stored credentials. `IS_API_URL` points at another host. `IDEASPACES_PI_EXTENSIONS` lists extension paths for the local agent.

## License

MIT
