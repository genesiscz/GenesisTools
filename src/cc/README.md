# tools cc

> **Short alias for `tools claude`, with `resume` as the default.**

`cc` is a dispatcher, not a separate tool. It forwards its arguments to `tools claude` and picks the subcommand for you, so the thing you do most often (resuming a session) costs three characters.

---

## Routing rules

| What you type | What actually runs |
|---------------|--------------------|
| `cc` | `claude resume` |
| `cc <query>` | `claude resume <query>` |
| `cc opus` / `cc fable` | `claude start opus` / `claude start fable` |
| `cc <known-subcommand> …` | `claude <known-subcommand> …` |

Known subcommands that pass straight through: `tail`, `history`, `resume`, `desktop`, `usage`, `code`, `info`, `config`, `daemon`, `migrate`, `login`, `login-long`, `login-secondary`, `logout`, `start`, `run`, `exec`, `doctor`.

Anything else is treated as a resume query. That is the point: `cc auth bug` searches your sessions for "auth bug" instead of erroring on an unknown command.

`opus` and `fable` are smart aliases. They pick the account from usage data and route to `start`, which falls back to a real account of that name when one exists.

---

## Quick start

```bash
cc                      # pick a recent session to resume
cc -l                   # list recent sessions
cc "timelog sync"       # resume the session that discussed this
cc -a "auth refactor"   # search every project, not just this one
cc -n 50 -l             # list the 50 most recent
cc opus                 # launch Claude Code on the opus account
cc history "worktree"   # forwarded to tools claude history
```

## Options for the default resume path

| Flag | Description |
|------|-------------|
| `-l, --list` | List recent sessions instead of resuming |
| `-a, --all-projects` | Search every project (default: current project only) |
| `-n, --limit <n>` | How many sessions to show (default: 20) |

---

## Notes

- Because `cc` spawns `tools claude`, every flag the target subcommand accepts works here too. `cc start myaccount -- --model opus` reaches `claude` unchanged.
- `cc --readme` prints this file. All other flags are forwarded.
- The real documentation for the underlying commands lives in [`src/claude/README.md`](../claude/README.md).
