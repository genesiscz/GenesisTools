# tools aliases

> **Mine shell history for the command chains you actually repeat, and propose aliases for them.**

Most alias lists are written once from imagination and then never match what you type. This reads your real history, scores what is genuinely hot, and only promotes an alias after it keeps showing up.

---

## Quick start

```bash
tools aliases analyze                       # what is hot, with suggested aliases
tools aliases analyze --top 40 --max-n 5
tools aliases apply --print                 # show the alias block, write nothing
tools aliases apply                         # write it into the managed rc block
tools aliases status                        # persisted alias levels, no scan
tools aliases decay                         # age out paths you stopped using
tools aliases reset                         # clear the state
```

## Commands

| Command | Description |
|---------|-------------|
| `analyze` | Mine history, show hot sequences and suggested aliases, scored |
| `apply` | Write suggested aliases into the managed rc block, or print them |
| `decay` | Age out unused paths: apply per-day decay, drop dead paths |
| `status` | Show the persisted alias-level state, no scan |
| `reset` | Clear the persisted alias-level state |

## Options for `analyze` and `apply`

| Flag | Description |
|------|-------------|
| `--history <file>` | Path to a history file (default: auto-detect zsh or bash) |
| `--min-n <n>` | Minimum n-gram length (default: 1) |
| `--max-n <n>` | Maximum n-gram length (default: 4) |
| `-t, --threshold <n>` | Minimum occurrences for a single command to be hot (default: 3) |
| `--chain-threshold <n>` | Minimum occurrences for a chain of 2 or more (default: 2) |
| `--top <n>` | Show at most N hot paths (default: 20) |
| `--no-state` | Pure scan: do not read or update alias-level state |
| `--json` | Emit the full report as JSON |

`apply` adds:

| Flag | Description |
|------|-------------|
| `--rc <file>` | Target rc file (default: auto-detect `~/.zshrc` or `~/.bashrc`) |
| `--min-level <n>` | Only emit paths whose alias level is at least n (default: 2) |
| `--print` | Print the alias block to stdout instead of writing the rc |

---

## Levels and decay

An alias is not proposed the first time a command repeats. Each hot path carries a **level** that rises as the path keeps appearing across scans, and `apply --min-level 2` means "only aliases that survived more than one look".

`decay` is the other half. It applies a per-day decay to every stored path and drops the dead ones, so a chain you hammered during one project does not sit in your rc file forever. Run it occasionally, or from a scheduled job.

`--no-state` gives you a pure scan with no effect on levels, which is the right flag for exploring thresholds.

## Notes

- ❗ `apply` writes to your rc file inside a **managed block**. It rewrites that block and leaves the rest of the file alone. Run `apply --print` first if you want to see the exact lines before they land.
- Chains are the real value. A single hot command is usually already short. `git add -A && git commit && git push` is where an alias pays.
- Related: [`tools zsh`](../zsh/README.md) manages the shell hook and feature modules, which is a different concern from aliases.
