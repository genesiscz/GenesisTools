# tools cmux

> **Save, inspect, and restore cmux workspace profiles.**

Crash recovery and repeatable layouts for cmux. A profile captures the workspace tree, each pane's working directory, its visible screen, and the last shell command it ran, so a restore can put you back where you were instead of in an empty grid.

---

## Commands

| Command | Description |
|---------|-------------|
| `profiles` | Manage saved workspace profiles |
| `doctor` | Read-only health probe: is cmux running, does its socket answer, is the UI thread starved |
| `rescue [name]` | Guided recovery from a livelocked cmux — offline capture, confirmed kill, clean relaunch, command replay |
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
| `--offline` | Build the profile from the autosave file plus the process table instead of the socket |

`--offline` exists for the case the socket cannot answer, which is exactly when you most
need a capture. ⚠️ It is a **weaker** capture: no visible screen and no scrollback, so the
per-pane command comes from the process table rather than from history. `save` falls back to
it automatically when the UI is starved, and says so.

---

## What "restore" actually restores

Three capture behaviours are **on by default**, and they are what makes a restore feel like a restore:

- **cwd**: each pane comes back in the directory it was in.
- **screen**: each terminal pane's rendered content is captured, so restore can paint it back. You see what was on screen, not a blank prompt.
- **history**: the scrollback is parsed for the most recent shell prompt and command, for example `claude --resume <id>`, and that command is **pre-typed at the new prompt**. You press Enter to resume, or edit it first.

Pre-typing rather than auto-running is deliberate. Restoring a layout should not silently re-execute commands.

`restore` is always non-destructive: it creates workspaces, it never closes yours.

`restore --enter` opts into **executing** each captured command instead of pre-typing it.
That reverses the safe default above, so it is opt-in and never implied.

Captured commands are reported with their **drift**: every difference between what the
process table showed and what will actually be replayed (an account added, a
`-- --resume <id>` appended). Restore prints the diff rather than hiding the rewrite.

## Recovery: `doctor` and `rescue`

```bash
tools cmux doctor                  # is it healthy, starved, or gone
tools cmux rescue --dry-run        # the full plan, touching nothing
tools cmux rescue before-reboot    # asks before it kills anything
```

`doctor` only reads. It reports whether the app is running, whether the socket answers a
ping and an identify inside their timeouts, and the app's CPU — a pegged UI thread that
still answers pings is the livelock signature.

`rescue` is the destructive counterpart and runs in this order:

1. capture an offline profile **before** anything else, so an abort still leaves it saved;
2. ask for confirmation (`--yes` to skip, and in a non-interactive shell `--yes` is
   **required** — it refuses rather than assuming);
3. `SIGTERM` the app, escalating to `SIGKILL` only after a 5 s grace window;
4. relaunch with a deliberately minimal environment, so agent markers like `CLAUDECODE`
   do not leak into every pane's login shell;
5. wait for the app to reopen its own workspaces, then type each captured command into the
   matching surface.

Replay is **title-checked per surface**: equal surface counts do not prove the panes still
correspond, so a surface whose reopened title differs from the captured one is skipped and
reported rather than typed into. Whatever a pane shows afterwards (an account gate, a resume
dialog) is reported, never answered — `rescue` types commands, it does not answer prompts.

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

⚠️ **That form is silent when it fails**, so check first: `tools cmux doctor` prints a
`send-self` line saying whether this surface would actually accept the keystrokes. A failed
send is still recorded in `~/.genesis-tools/logs/<today>.log` even with stderr discarded.

🛑 **Never pass `--workspace` alongside a surface UUID or `surface:N` ref.** `cmux send` looks
the surface up INSIDE the workspace you name, so a stale `CMUX_WORKSPACE_ID` — which is what
you get the moment a surface is moved to another workspace — makes the app answer
`invalid_params: Surface is not a terminal` about a perfectly good terminal. The surface id
alone is unique across the whole tree; `surfaceTargetArgs()` in `src/utils/cmux/lib/target.ts`
is the one place that decides this.

## Notes

- Profiles are JSON under `~/.genesis-tools/cmux/profiles/`. `edit` opens one, and `path` tells you where it is, so hand-tuning a layout is expected rather than discouraged.
- Related: `tools claude cmux` reopens recent Claude Code sessions as cmux workspaces, which is the session-oriented counterpart to this layout-oriented tool. [`tools tmux`](../tmux/README.md) does the equivalent job for tmux.
