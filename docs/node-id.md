# Local node_id repair

Positioned markdown nodes carry a stable `node_id` in frontmatter. Do not edit it by hand: links, move history, and future push checks rely on it staying stable.

Use the CLI to inspect or repair local files before pushing:

```bash
ideaspaces id .                    # check markdown files
ideaspaces id --fix .              # inject missing node_id fields
ideaspaces id --regenerate copy.md # intentionally reset one copied/bad file
ideaspaces id install-hook         # install repo-local pre-commit repair hook
```

The command preserves valid legacy IDs (`n_` + 12 hex chars) and new IDs (`n_` + 24 hex chars). New IDs minted locally use the 96-bit form.

`--fix` only injects missing IDs. Malformed IDs and duplicate-copy conflicts require `--regenerate <path>` so the user chooses which file receives a new identity.

The pre-commit hook runs:

```bash
ideaspaces id --fix --staged
```

If a staged markdown file also has unstaged edits, the hook refuses to modify it. Stage or stash those changes, then retry.
