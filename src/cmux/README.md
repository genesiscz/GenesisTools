# tools cmux

> **Save, inspect, and restore cmux workspace profiles.**

Crash recovery and repeatable layouts for cmux. A profile captures the workspace tree, each pane's working directory, its visible screen, and the last shell command it ran, so a restore can put you back where you were instead of in an empty grid.

---

## Commands

| Command | Description |
|---------|-------------|
| `profiles` | Manage saved workspace profiles |
| `restore-after-restart` | Guided (or `--source`/`--list`/`--dry-run`) restore of the pre-restart layout with Claude, Grok, and Codex resume commands |
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

`--offline` captures from native autosave and the local command/viewport caches without activating any UI. It preserves available saved output, but cannot fetch a fresh viewport while the socket is unavailable. `save` falls back to it when the UI is starved and reports that fallback.

---

## What "restore" actually restores

Three capture behaviours are **on by default**, and they are what makes a restore feel like a restore:

- **cwd**: each pane comes back in the directory it was in.
- **screen**: each terminal pane's rendered content is captured, so restore can paint it back. You see what was on screen, not a blank prompt.
- **history**: the scrollback is parsed for the most recent shell prompt and command, for example `claude --resume <id>`, and that command is **pre-typed at the new prompt**. You press Enter to resume, or edit it first.

Pre-typing rather than auto-running is deliberate. Restoring a layout should not silently re-execute commands.

`restore` is always non-destructive: it creates workspaces, it never closes yours.

## `restore-after-restart`

After a cmux app restart, rebuild the previous panes as new workspaces and pre-type Claude, Grok, and Codex resume commands. Always non-destructive. Default workspace prefix is `restart-`.

```bash
tools cmux restore-after-restart --source previous --dry-run
tools cmux restore-after-restart --source previous --agents grok,claude --enter -y
tools cmux restore-after-restart --list --source previous
```

| Flag | Description |
|------|-------------|
| `--source [source]` | `previous` (autosave `*-previous.json`), `live` (socket, then current autosave), or `profile` |
| `--profile <name>` | Named profile. Required with `--source profile` off TTY |
| `--agents [list]` | `claude`, `grok`, `codex`. Default is all three |
| `--enter` | Press Enter after typing each resume command |
| `--no-replay` | Only `cd` into cwd |
| `--prefix <str>` | Workspace name prefix (default `restart-`) |
| `--list` | Print the layout and inferred commands, then exit |
| `--dry-run` | Print the restore plan without modifying cmux |
| `-y, --yes` | Skip confirmation. Required off TTY |

`previous` is the file cmux renamed aside on last launch, not the live layout.

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

## Install automatic capture

The same installer is available through either tool:

```bash
tools cmux capture install
# Equivalent:
tools zsh cmux install
```

Installation previews its managed rc block and asks before editing your zsh rc file. In non-interactive use, pass `--yes` to approve that edit; `--dry-run` previews without writing files or starting a collector. Uninstall follows the same confirmation rule. Repeating installation reports that it is already installed and does not duplicate or rewrite an unchanged rc block.

The installer generates the hook and standalone runtimes under `~/.genesis-tools/cmux/`; their source lives in this repository. The installed runtime does not depend on the checkout or worktree remaining at its original path. Bun must remain installed; the hook uses PATH and then a global Bun fallback. Existing rc content is backed up before an approved change, and concurrent edits after preview are refused.

Rerun `install` after updating GenesisTools to rebuild the installed artifacts. The generated hook invokes a stable managed symlink, `runtime/capture-record.js`, which points to the current versioned bundle. Switching that symlink updates the recorder for already-loaded modern hooks without pointing them into a removable worktree. Source-code changes are not silently hot-loaded. Changes to the shell functions themselves require re-sourcing the hook or a new shell, just as they would with a direct symlink to a source script.

New interactive cmux zsh terminals capture automatically. Existing idle shells can reload `~/.genesis-tools/cmux/capture.zsh`; running agents are not interrupted. Reinstalling the same version is idempotent. A changed collector version takes over through a new ownership token; the old process exits without PID signals.

```bash
tools cmux capture status
# Equivalent:
tools zsh cmux status

# Commands only, without viewport sampling:
tools cmux capture install --no-screens

# Stop sampling and remove the managed rc block; keep captured data:
tools cmux capture uninstall
# Equivalent:
tools zsh cmux uninstall
```

All three lifecycle commands support `--home <directory>`, `--rc <path>`, and `--json`. Install/uninstall support `--dry-run` and `--yes` for preview and rc-edit approval. Status is read-only. Uninstall leaves existing shell functions loaded until that shell reloads or exits. `capture shell zsh` remains an advanced script-generation command; use `install` for portable managed installation.

## What is recorded

- Exact local zsh command text and launch directory, synchronously before execution. Completion retains the command and its exit status. Pipelines and quotes are preserved; tab titles are never executed as commands.
- Runtime surface UUID plus cmux's persisted `stableSurfaceId` when available. `surface:N` is an in-memory routing reference, not a durable identifier. Workspace IDs are informational: moving a panel does not redirect its history to another panel. A saved association bridges stale shell environment IDs; the collector fills associations after native autosave supplies a new panel's stable identity.
- Current visible terminal text, sampled roughly every 15 seconds plus collection time, with a maximum of 200 lines / 200,000 characters per surface. This is a viewport snapshot, not a full scrollback recorder. Unchanged viewports are not rewritten.
- Native autosave layout, pane proportions, tab order/selection, titles and directories. Native saved text and browser URLs are retained when provided. The current viewport cache also feeds offline/previous-autosave recovery.

The collector reads local socket data only. It never focuses or initializes dormant terminals, types commands, launches agents, or answers dialogs. A socket outage stops that collection pass and leaves the previous cache intact. A process lock and ownership token prevent duplicate collectors from the same installation.

## Resource use and retention

Viewport cache has a 64 MiB total budget, including previous versions and the pre-restart archive. Oldest snapshots are removed when the budget is exceeded. The collector preserves the last cached screens when the native previous-autosave generation changes, and historical restore never substitutes a newer screen for an older cutoff.

Command journals retain two generations of up to 1 MiB per surface. Old surface journals remain until explicitly removed; commands over 65,536 characters are rejected visibly. Runtime diagnostics retain two 1 MiB generations. Files are private local data: directories mode 0700, new data files mode 0600. Commands and visible output can contain sensitive text, so do not publish the data directory or copy its contents into test fixtures.

Capture can miss output between samples, terminals that never initialized, and data older than the retention budget. Recording must be installed before a command runs; it cannot recover missing earlier commands retrospectively.

## Covered examples

- `tail -f service.log`, `bun run dev`, and CLI monitors: preserve command, launch directory, viewport text, and surrounding cmux layout. Restore can relaunch the command when explicitly requested.
- `git status`, `tools ai usage`, and other completed commands: retain the last command and visible output even after the process exits.
- Commands with quoted arguments, pipes, and multiple shell statements: retain the typed shell syntax rather than a flattened process argument list.
- Moving an existing terminal between panes/workspaces: retain the surface association independently of workspace location and current numbered references.
- `vim notes.md`, `ssh example-host`, or `tmux attach -t example`: preserve the outer launch command and visible snapshot. Application-specific state is not implied.
- Browser tabs: restore their saved URL, including a browser as the first tab in a pane, when the URL was available to capture.

## Uncovered or approximate examples

- Unsaved editor buffers, cursor/selection state, running process memory, shell-local variables, background job state, and exact process IDs.
- Commands typed inside an SSH shell, nested shell, or TUI: only the owning local zsh launch command is captured.
- Browser cookies, form inputs, authentication flows, navigation history, and exact page state.
- Exact window placement, pixel/cell equality from offline estimates, and cmux-specific non-terminal panels such as project or custom-sidebar tools.
- Agent authentication, resume confirmations, and a second process trying to own a session already running elsewhere. Restore never auto-confirms these.

Saved terminal text is historical output, not evidence that its original program is running. By default restore types the command for inspection; `--enter` explicitly requests execution. Success of the launcher does not guarantee the restarted application returns to identical internal state.
