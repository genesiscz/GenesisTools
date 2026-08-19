# tools regret-grep

> **Warn when the current diff repeats a bug you already fixed.**

Your git history is a record of mistakes you have already paid for. This indexes the fixes and scores your working tree against them, so the second time you write the same bug something says so.

---

## Quick start

```bash
tools regret-grep index                          # build the index once
tools regret-grep index --since '6 months ago'   # bound how far back to read
tools regret-grep check                          # score the working tree
tools regret-grep check --staged                 # score what you are about to commit
tools regret-grep check --diff /tmp/patch.diff   # score a diff file
tools regret-grep check --threshold 0.3 --top 3
```

## Commands and options

| Command | Description |
|---------|-------------|
| `index` | Build or update the local index of past bug-fix commits |
| `check` | Score the current diff against past bug fixes and warn on repeats |

### `index` options

| Flag | Description |
|------|-------------|
| `--since <when>` | Only index commits since this git date, for example `'6 months ago'` |

### `check` options

| Flag | Description |
|------|-------------|
| `--diff <file>` | Score this unified-diff file instead of the working tree |
| `--staged` | Score the staged diff (`git diff --cached`) |
| `--threshold <n>` | Minimum cosine similarity to report, 0 to 1 (default: 0.15) |
| `--top <n>` | Maximum number of matches to report (default: 5) |

---

## How the score works

`index` reads commits that look like fixes and stores a representation of each one. `check` embeds your current diff and reports past fixes above the similarity threshold, most similar first.

The default threshold of 0.15 is deliberately loose. It surfaces weak matches, most of which are noise, on the theory that a glance is cheap and a repeated bug is not. Raise it to 0.3 or higher once you know your repo's baseline, and lower it when hunting.

This is a hint generator, not a linter. A match means "you touched code that resembles code you once fixed", which is often a coincidence and occasionally the exact warning you needed.

## Notes

- Run `index` again periodically. It reads history, so new fixes are invisible until you do.
- `--staged` is the pre-commit form. Pair it with a hook if you want the check to be automatic rather than remembered.
- The index is local. Nothing leaves the machine.
