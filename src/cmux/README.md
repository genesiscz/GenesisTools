# tools cmux

> **Save, inspect, and restore cmux workspace profiles.**

Crash recovery and repeatable layouts for cmux. A profile captures the workspace tree, each pane's working directory, its visible screen, and the last shell command it ran, so a restore can put you back where you were instead of in an empty grid.

---

## Commands

| Command | Description |
|---------|-------------|
| `profiles` | Manage saved workspace profiles |
| `send-self <text>` | Type text into the terminal surface this process is running in, then press Enter |

### `profiles` subcommands

| Command | Description |
|---------|-------------|
| `save [name]` | Capture a cmux layout into a named profile |
| `list` (alias `ls`) | List saved profiles |
| `view <name>` (alias `show`) | Show a saved profile as a rich tree |
| `restore <name>` | Recreate workspaces from a saved profile. Always non-destructive. |
| `edit <name>` | Open the profile JSON in `$VISUAL` or `$EDITOR` |
| `delete <name>` (alias `rm`) | Remove a saved profile |
| `path [name]` | Print the absolute path of a profile, or of the profiles directory |

## Quick start

```bash
tools cmux profiles save work
tools cmux profiles save api --scope workspace --workspace 2
tools cmux profiles list
tools cmux profiles view work
tools cmux profiles restore work
tools cmux profiles path work
tools cmux profiles save work --force            # overwrite
```

### `save` options

| Flag | Description |
|------|-------------|
| `-s, --scope <scope>` | `all`, `window` or `workspace` |
| `--workspace <ref>` | Target workspace, only with `--scope workspace` |
| `--window <ref>` | Target window, only with `--scope window` |
| `--no-cwd` | Skip per-pane working-directory capture |
| `--no-screen` | Skip visible-screen capture |
| `--no-history` | Skip last-shell-command capture |
| `--note <text>` | Free-form note stored on the profile |
| `-f, --force` | Overwrite an existing profile of the same name |

---

## What "restore" actually restores

Three capture behaviours are **on by default**, and they are what makes a restore feel like a restore:

- **cwd**: each pane comes back in the directory it was in.
- **screen**: each terminal pane's rendered content is captured, so restore can paint it back. You see what was on screen, not a blank prompt.
- **history**: the scrollback is parsed for the most recent shell prompt and command, for example `claude --resume <id>`, and that command is **pre-typed at the new prompt**. You press Enter to resume, or edit it first.

Pre-typing rather than auto-running is deliberate. Restoring a layout should not silently re-execute commands.

`restore` is always non-destructive: it creates workspaces, it never closes yours.

## `send-self`

```bash
tools cmux send-self '/compact'
tools cmux send-self 'text' --no-enter
tools cmux send-self 'text' --dry-run
```

| Flag | Description |
|------|-------------|
| `--enter-delay <ms>` | Wait this long between the text and Enter (default: 500) |
| `--no-enter` | Send the text only, leave it unsubmitted at the prompt |
| `--target <auto\|tmux\|cmux>` | Force a transport instead of auto-detecting (default: `auto`) |
| `--dry-run` | Print the resolved target and exit without sending |

❗ **To fire later, put the sleep in the calling shell, not here.** A long-lived bun process is killed at an agent turn boundary, so an in-process delay never arrives. Detach it instead:

```bash
nohup zsh -c "sleep 300; tools cmux send-self '/compact'" </dev/null >/dev/null 2>&1 &
```

## Notes

- Profiles are JSON under `~/.genesis-tools/cmux/profiles/`. `edit` opens one, and `path` tells you where it is, so hand-tuning a layout is expected rather than discouraged.
- Related: `tools claude cmux` reopens recent Claude Code sessions as cmux workspaces, which is the session-oriented counterpart to this layout-oriented tool. [`tools tmux`](../tmux/README.md) does the equivalent job for tmux.
