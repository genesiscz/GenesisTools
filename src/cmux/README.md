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
| `agents new <claude\|grok\|codex> --repo <name\|path> --account <name>` | Open a background workspace in the focused cmux window and start `tools <agent> run` there; the session is recorded under its name. Without `--account` it starts nothing and lists every account with its 5h and weekly budget left (an agent must ask the user, or pick and tell the user). Claude starts with `--cross-messages` unless `--no-cross-messages` |
| `agents list [--all]` | Sessions `agents new` opened; `--all` adds every other live agent session in cmux (from the cmux-refs journal) |
| `agents close <name\|session-id\|surface\|workspace>` | Quit the agent (`/exit`, Codex `/quit`), then close its workspace; an adopted session (not opened by `agents new`) closes only its surface |

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

After cmux crashes or restarts, put every tab back the way it was: each agent tab gets its
Claude, Grok or Codex session again, and each shell tab gets its last command.

There are two modes:

- **`--in-place`** (the usual case): cmux already reopened your tabs as empty shells, with
  their titles and directories. The restore types into those same tabs. Nothing new is
  created.
- **Default**: rebuild the layout as new workspaces (prefix `restart-`). Use it when cmux did
  not reopen the tabs, or to restore from the pre-restart autosave or a saved profile.

### Quick start

```bash
# 1. See what would happen. Reads in the background; it never switches your workspace.
tools cmux restore-after-restart --in-place --dry-run

# 2. Resume every agent tab and run the resumes. Shell commands are typed, not run.
tools cmux restore-after-restart --in-place --enter -y

# Also run the restored shell commands (an `ssh host` tab logs in again):
tools cmux restore-after-restart --in-place --enter --run-commands -y

# cmux did not reopen the tabs: rebuild them from the pre-restart autosave.
tools cmux restore-after-restart --source previous --dry-run
tools cmux restore-after-restart --source previous --agents grok,claude --enter -y
```

| Flag | Description |
|------|-------------|
| `--in-place` | Restore into the tabs cmux reopened, matched by surface UUID. Implies `--source live` |
| `--run-commands` | With `--in-place`: also press Enter on restored shell commands |
| `--source [source]` | `previous` (autosave `*-previous.json`), `live` (socket, then current autosave), or `profile` |
| `--profile <name>` | Named profile. Required with `--source profile` off TTY |
| `--agents [list]` | `claude`, `grok`, `codex`. Default is all three |
| `--enter` | Press Enter after typing each agent resume command |
| `--no-replay` | Only `cd` into the directory |
| `--prefix <str>` | Workspace name prefix for new workspaces (default `restart-`) |
| `--window <ref>` | Restore new workspaces into this window (`window:N`, index or uuid) |
| `--list` | Print the layout and the inferred commands, then exit |
| `--dry-run` | Print the plan without changing anything |
| `-y, --yes` | Skip confirmation. Required off TTY |

### What `--in-place` types, tab by tab

The plan prints one line per tab: `▶ resume: <command>`, `▶ type (shell command): <command>`,
or `· skip: <reason>`. A tab is typed into only when all of these hold:

- Its surface UUID is in the live layout. cmux keeps the UUID across a relaunch, while the
  `surface:N` refs are renumbered, so the pairing never depends on a ref or a tab position.
- Its tty runs nothing but a shell. A tab with an agent, an `ssh`, a `tail -f` or any other
  program is busy. When a busy tab runs a different agent than the journal recorded (cmux's
  own restore can pick a stale session), the skip line names the recorded session.
- Its prompt is empty. Text already typed at the prompt is never overwritten.
- It is not the tab running the restore.
- For an agent: a concrete session id is resolved, and the evidence is the surface journal or
  the tab title (see below). A weaker match is printed with its command, never typed.

After it resumes a session, the restore writes that tab's record to the surface journal, so
the next relaunch finds it even if the agent's own hook did not run.

### How each tab's session is chosen

The session is identified by **where it ran**, not by the command you typed. You may start
Claude through any alias, function or wrapper (`cr work`, `ffff`, a shell function), then
`/rename` the session: the restore still resumes the right one. In order:

1. **A live process on the tab's tty** (`claude … --resume <uuid>`): it names the session it
   runs.
2. **The surface journal** (`~/.genesis-tools/claude-code/cmux-refs.jsonl`). The
   genesis-tools plugin hook writes the session id with the tab's `CMUX_SURFACE_ID` at
   session start and on every prompt, for Claude, Codex and Grok. The newest record for the
   tab's UUID wins, with these rules for the tab's last shell command:
   - The journal saw the session **after** that command started: the session was the tab's
     last occupant, so it is resumed, whatever the command was. A launcher the code does not
     know becomes `tools claude start <account> -- --resume <id>` (account from the pin
     journal).
   - The command started **after** the session's last record (you quit Claude and ran
     `ssh host`): the command was the last thing the tab did, so it is restored instead.
   - `cmux restore <agent> <id>`, which cmux types itself at a relaunch, does not count as
     your activity. When the journal names a different session for the tab, the journal wins.
   - A `tools cmux agents new` line resumes its session. It never sends the first prompt
     again, which would start the whole task a second time.
3. **The tab title**, only when the journal has no record for the tab. An exact title match
   in the tab's own directory wins over sessions whose names extend it
   (`pr-7210-logs` beats `pr-7210-logs-scripts`). The drift line says
   `session picked by tab title "…"`.
4. **Weak evidence**: words of the first prompt, or a title match in another directory. It is
   shown in the drift and the plan, and `--in-place` does not type it.

When the typed launcher is a known one, its flags are kept and only the session id is
attached: `cr work -m sonnet` becomes `cr work -m sonnet -- --resume <uuid>`. Any executable
under `~/.aliases/` whose body runs `exec tools cc run` or `exec tools claude run` counts as
known, whatever its name. The id lands after `--`, where claude itself reads it; a cc run
level `--resume <query>` is a fuzzy search, so it is replaced by the id. When two tabs resolve
to one session id, the tab whose title names the session keeps the resume and the other gets
no command, because a second `--resume` of a running session forks it.

Shell commands come from the local shell journal, so a command you typed inside an `ssh`
session is not recorded; the tab gets the `ssh host` line that started it.

### When a tab says "no session id resolved"

- `tools claude cmux tree` shows the journal's session for each live tab. A tab without one
  has no journal record.
- `claude plugin list` must show `genesis-tools@genesis-tools` as `✔ enabled`. The journal
  hook runs only where that plugin loaded. On 2026-10-14 a broken marketplace manifest kept
  it off for twelve hours, and every session started in that time had no journal record.
- `previous` is the file cmux renamed aside on its last launch, not the live layout.
- `--dry-run` and `--list` read the cached session catalog; the real run refreshes it first,
  so it can resolve a session the preview could not.

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
| `--enter-delay <ms>` | Wait this long between the text and Enter (default: 0, back-to-back; cmux and tmux both accept it) |
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

The installer generates the hook and standalone runtimes under `~/.genesis-tools/cmux/`; their source lives in this repository. Installation and the viewport collector require Bun. The lightweight zsh command hook uses built-in append/stat operations and does not launch Bun per command. Installed files do not depend on the checkout or worktree remaining at its original path. Existing rc content is backed up before an approved change, and concurrent edits after preview are refused.

Rerun `install` after updating GenesisTools to rebuild the installed artifacts. The stable managed symlink `runtime/capture-record.js` remains available for older loaded recorder-based hooks; updating it refreshes their recorder without depending on a removable worktree. Current hooks append lightweight NUL-delimited spool records directly, which the capture reader validates alongside legacy JSONL journals. Source-code changes are not silently hot-loaded. Changes to shell functions require re-sourcing the hook or a new shell, just as with a direct symlink to a source script.

New interactive cmux zsh terminals capture automatically. Existing idle shells can reload `~/.genesis-tools/cmux/capture.zsh`; running agents are not interrupted. Reinstalling the same version is idempotent. A changed collector version takes over through a new ownership token; the old process exits without PID signals.

The viewport collector currently runs for the current login only; it is not a launchd login service and is not automatically restarted after a reboot or process crash. Command capture resumes in new zsh shells, but to resume viewport sampling rerun `tools cmux capture install` (or `tools zsh cmux install`, with the same custom home/rc options if used). Status distinguishes `enabled, not running` from `running` and prints this recovery guidance. Existing cached viewports remain available while the collector is stopped.

Stable-ID association is independent of viewport sampling: a missing association starts one background resolver, which retries native autosave discovery for up to 30 seconds. Shell events can retry later at most once per 30 seconds until an association exists. It does not block command execution, and it also runs with `--no-screens`. The association task requires the installed Bun recorder; the lightweight command write itself does not.

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

- Exact local zsh command text and launch directory, written before execution. Completion retains the command and its exit status. The write finishes before the command starts, but the lightweight spool does not force a disk fsync per event; abrupt power loss can lose recently buffered writes. Pipelines and quotes are preserved; tab titles are never executed as commands.
- Runtime surface UUID plus cmux's persisted `stableSurfaceId` when available. `surface:N` is an in-memory routing reference, not a durable identifier. Workspace IDs are informational: moving a panel does not redirect its history to another panel. A saved association bridges stale shell environment IDs; the collector fills associations after native autosave supplies a new panel's stable identity.
- Current visible terminal text, sampled roughly every 15 seconds plus collection time, with a maximum of 200 lines / 200,000 characters per surface. This is a viewport snapshot, not a full scrollback recorder. Unchanged viewports are not rewritten.
- Native autosave layout, pane proportions, tab order/selection, titles and directories. Native saved text and browser URLs are retained when provided. The current viewport cache also feeds offline/previous-autosave recovery.

The collector reads local socket data only. It never focuses or initializes dormant terminals, types commands, launches agents, or answers dialogs. A socket outage stops that collection pass and leaves the previous cache intact. A process lock and ownership token prevent duplicate collectors from the same installation.

## Resource use and retention

Viewport cache has a 64 MiB total budget, including previous versions and the pre-restart archive. Oldest snapshots are removed when the budget is exceeded. The collector preserves the last cached screens when the native previous-autosave generation changes, and historical restore never substitutes a newer screen for an older cutoff.

Command spools retain two bounded generations of approximately 1 MiB per surface; existing JSONL journals remain readable and retain their separate two-generation limit. Old surface records remain until explicitly removed; the lightweight hook visibly rejects commands over 65,536 bytes. Runtime diagnostics retain two 1 MiB generations. Files are private local data: directories mode 0700, new data files mode 0600. Commands and visible output can contain sensitive text, so do not publish the data directory or copy its contents into test fixtures.

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
