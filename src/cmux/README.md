# tools cmux

Save, restore and recover [cmux](https://github.com/manaflow-ai/cmux) layouts, and run Claude, Codex and Grok
sessions in cmux workspaces. After cmux crashes or restarts, it puts every tab back the way it was: each agent tab
gets its session again, and each shell tab gets its last command. It also keeps named layouts you can rebuild, and
starts, lists and closes agent sessions in background workspaces.

"cmux" here is the AI-native macOS terminal multiplexer from manaflow-ai, not the Go library of the same name.

## Quick start

```bash
# After cmux restarted: see what the in-place restore would type, and change nothing.
tools cmux restore-after-restart --in-place --dry-run

# Resume every agent tab in place and run the resumes.
tools cmux restore-after-restart --in-place --enter -y

# Is cmux healthy, starved or gone? Read-only.
tools cmux doctor

# Save the whole layout as a named profile.
tools cmux profiles save work --scope all

# Rebuild that profile later as new workspaces.
tools cmux profiles restore work

# Record every shell command and screen from now on, so a later restore has evidence.
tools cmux capture install
```

## Commands

`tools cmux --help` lists the groups, and `tools cmux <command> --help` lists each one's flags. The global
`-v, --verbose` option turns on debug logging for any command.

### Layout profiles: `profiles`

A profile is the window, workspace, pane and tab tree, with each pane's directory, its visible screen and the last
shell command it ran.

| Command | What it does |
|---------|--------------|
| `profiles save [name]` | Capture a layout into `~/.genesis-tools/cmux/profiles/<name>.json` |
| `profiles list` (alias `ls`) | List saved profiles. `--json` for JSON |
| `profiles view <name>` (alias `show`) | Show a profile as a tree. `--json` prints the raw profile |
| `profiles restore <name>` | Recreate the profile's workspaces. Always non-destructive |
| `profiles edit <name>` | Open the profile JSON in `$VISUAL` or `$EDITOR` (else `vi`) |
| `profiles delete <name>` (alias `rm`) | Remove a profile. `-y` skips the prompt; required off a TTY |
| `profiles path [name]` | Print a profile's absolute path, or the profiles folder |

```bash
tools cmux profiles save work --scope all
tools cmux profiles save api --scope workspace --workspace workspace:2
tools cmux profiles save work --scope all --force   # overwrite
tools cmux profiles list
tools cmux profiles view work
tools cmux profiles restore work --dry-run
tools cmux profiles path work
```

`profiles save` flags:

| Flag | Meaning |
|------|---------|
| `-s, --scope <scope>` | `all`, `window` or `workspace`. Required off a TTY |
| `--workspace <ref>` | `workspace:N` or a UUID, only with `--scope workspace` (default: focused) |
| `--window <ref>` | Target window, only with `--scope window` (default: focused) |
| `--no-cwd` | Skip each pane's working directory |
| `--no-screen` | Skip each pane's visible screen |
| `--no-history` | Skip each pane's last shell command |
| `--note <text>` | Free-form note stored on the profile |
| `-f, --force` | Overwrite a profile of the same name |
| `--offline` | Build the profile from cmux's autosave and local caches, without the socket |

On a TTY, `save` asks for the scope, the data to capture and the name (the default name is the scope: `all`,
`window` or `workspace`). Off a TTY, pass the name and `--scope`. A name uses letters, digits, dots, underscores and
dashes. An existing name needs `--force`, or a yes at the prompt.

`--offline` captures from cmux's native autosave and the local command and screen caches, and activates no UI. It
keeps the saved output it can find, but it cannot read a fresh screen while the socket is down. It always covers
everything in the autosave, so it refuses `--scope`, `--workspace` and `--window`. When cmux is not healthy, `save`
falls back to offline capture by itself and says so. It fails instead when you asked for something offline capture
cannot honor (a scope other than `all`, `--no-cwd` or `--no-history`).

`profiles restore` flags:

| Flag | Meaning |
|------|---------|
| `--prefix <str>` | Prefix for the new workspace names (default `<name>-`) |
| `--no-replay` | Only `cd` into each pane's directory; type no command |
| `--enter` | Press Enter after each replayed command, so it runs |
| `-y, --yes` | Skip the confirmation. Required off a TTY |
| `--dry-run` | Print the plan, with each pane's command and drift, and change nothing |

### Restore after a restart: `restore-after-restart`

Puts every tab back after cmux crashed or restarted: each agent tab gets its Claude, Grok or Codex session (found by
the tab's surface UUID), and each shell tab gets its last command. `--in-place` types into the tabs cmux reopened;
without it, the layout is rebuilt as new workspaces. The details are in
[How restore-after-restart works](#how-restore-after-restart-works).

| Flag | Meaning |
|------|---------|
| `--in-place` | Type into the tabs cmux reopened. Implies, and accepts only, `--source live` |
| `--run-commands` | With `--in-place`: also press Enter on restored shell commands |
| `--source [source]` | `previous` (pre-restart autosave), `live` (socket, then autosave) or `profile` |
| `--profile <name>` | Named profile for `--source profile`. Required off a TTY with that source |
| `--agents [list]` | Comma list of `claude`, `grok`, `codex`. Default: all three |
| `--enter` | Press Enter after typing each agent resume command |
| `--no-replay` | Only `cd` into each directory; type no resume command |
| `--prefix <str>` | Name prefix for new workspaces (default `restart-`) |
| `--window <ref>` | Put new workspaces into this window (`window:N`, an index or a UUID) |
| `--list` | Print the layout and the inferred commands, then exit |
| `--dry-run` | Print the plan without changing anything |
| `-y, --yes` | Skip the confirmation. Required off a TTY |

`--in-place` matches each tab by its surface UUID. Without `--run-commands`, it types restored shell commands and
does not run them.

Off a TTY, `--source` is required unless `--in-place` is given. `--in-place` with any other `--source` fails
(exit 1). On a TTY, a missing `--source` or `--profile` opens a picker. A missing `--agents` or `--enter` opens a
picker or a question too, unless `--yes`, `--list` or `--dry-run` is given.

### Health and recovery: `doctor`, `rescue`

| Command | What it does |
|---------|--------------|
| `doctor` | Read-only health probe. `--json` prints the health object with `selfSend` and `journal` |
| `rescue [name]` | Recover a livelocked cmux: save, confirmed kill, clean relaunch, in-place replay |

```bash
tools cmux doctor                  # is it healthy, starved, or gone
tools cmux rescue --dry-run        # the full plan, touching nothing
tools cmux rescue before-reboot    # asks before it kills anything
```

`doctor` prints one line each for the app (pid and CPU), the socket `ping`, `capabilities` and `identify` probes
with their times, `send-self` (whether this shell could type into its own prompt), and `journal` (how many live tabs
and agent tabs the surface journal has a record for). It ends with a verdict: `healthy`, `not-running`,
`socket-dead`, `access-denied` or `ui-starved`. A pegged UI thread that still answers pings is the livelock
signature, and for it `doctor` prints a rescue recipe. See [How rescue works](#how-rescue-works).

`rescue` takes `-y, --yes` (skip the confirmation; required off a TTY) and `--dry-run` (print the full plan, with
each pane's command and drift, and touch nothing). It saves its capture as profile `rescue` unless you name another.

### Agent sessions: `agents`, `launch`

| Command | What it does |
|---------|--------------|
| `agents new <agent>` | Start `claude`, `codex` or `grok` in a background workspace |
| `agents list` | Sessions `agents new` opened that are not closed yet |
| `agents status` | Every agent session's title, state, last activity and last assistant message |
| `agents close <session>` | Quit the agent, then close its workspace (an adopted session: its surface) |
| `launch [claudeArgs...]` | Print the command that starts Claude in a new surface; `--open` runs it |

```bash
# Without --account it starts nothing and lists each account's budget left.
tools cmux agents new claude --repo ~/Projects/app
tools cmux agents new claude --repo ~/Projects/app --account work --name fix-login
tools cmux agents new codex --repo ~/Projects/app --account work --prompt-file ./task.md
tools cmux agents list --all
tools cmux agents status
tools cmux agents close fix-login --dry-run
```

`agents new` flags:

| Flag | Meaning |
|------|---------|
| `--repo <name\|path>` | Required. A folder name under `~/Tresors/Projects`, or a path such as `./app` |
| `--account <name>` | Required to start. Omit it to list each account's 5h and weekly budget left |
| `--model <id>` | Model id or alias, passed as `tools <agent> run -m` |
| `--prompt <text>` | First prompt, passed after `--`. 8 KB at most. Not with `--prompt-file` |
| `--prompt-file <path>` | Read the first prompt from a file when the workspace command runs |
| `--name <title>` | Session name and workspace title |
| `--via-tmux` | Run the agent inside a detached tmux session and attach the workspace to it |
| `--focus [value]` | `true` switches to the new workspace (default `false`) |
| `--cross-messages` | Claude: accept `tools claude message` without approval in this session |
| `--no-cross-messages` | Claude: leave the choice to Claude Code's own settings |
| `--json` | Print name, agent, account, workspace, surface, window, tmuxSession, cwd and command |

`agents list` takes `--agent <id>` (one agent only), `--all` (also every agent session `agents new` did not open,
which `close` can adopt) and `--json`. `agents status` takes `--agent <id>` and `--json`.

`agents close <session>` takes a session name, a session id, a surface or a workspace ref, and these flags:

| Flag | Meaning |
|------|---------|
| `--force` | Close a workspace with no agent session, a running turn, or an agent that did not quit |
| `--kill-tmux` | Also kill the tmux session of a `--via-tmux` session |
| `--grace <seconds>` | How long to wait for the agent to quit (default `10`) |
| `--dry-run` | Print the plan and the checks; close nothing |
| `--json` | Print the report as JSON |

`launch` flags:

| Flag | Meaning |
|------|---------|
| `--prompt <text>` | The prompt. This or `--prompt-file` is required; 8 KB at most |
| `--prompt-file <path>` | Read the prompt from a file; wins over `--prompt`. No 8 KB cap |
| `--account <name>` | Saved Claude account, or `auto` (most headroom). Default: the default account |
| `--name <name>` | Session name (`claude -n`) and the new tab's title |
| `--resume <query>` | Resume a session (`tools claude run -r`) |
| `--model <model>` | Model (`tools claude run -m`) |
| `--cwd <dir>` | `cd` here first |
| `--surface [kind]` | `new` (default: a new tab in the focused pane), `split` or `workspace` |
| `--agent [name]` | Launcher to use. Only `claude` exists so far |
| `--run-arg <arg>` | Extra argument for `tools claude run`, before `--`. Repeatable |
| `--claude-arg <arg>` | Extra argument for claude, after `--`. Repeatable |
| `--json` | Print the launch plan as JSON instead of the shell line |
| `--open` | Open the surface in cmux and type the command there |

Trailing arguments (`[claudeArgs...]`) go to the same place as `--claude-arg`.

```bash
tools cmux launch --prompt "Fix the failing test" --cwd ~/Projects/app
tools cmux launch --prompt "Fix the failing test" --cwd ~/Projects/app --account auto --open --surface split
```

### Automatic capture: `capture`

| Command | What it does |
|---------|--------------|
| `capture install` | Bundle and install durable capture for future zsh shells |
| `capture uninstall` | Remove the managed rc block; keep the captured data and the installed files |
| `capture status` | Inspect the installation; changes nothing |
| `capture shell zsh` | Print the sourceable zsh integration (zsh only); edits no rc file |

The three lifecycle commands share one flag set. `status` reads only, whatever flags it gets.

| Flag | Meaning |
|------|---------|
| `--home <directory>` | Home folder that holds `.genesis-tools` (default: the configured tools home) |
| `--rc <path>` | Zsh rc file to manage (default `<home>/.zshrc`) |
| `--no-screens` | No background screen collector; command capture only |
| `--json` | Print the installation details as JSON |
| `--yes` | Approve the rc file change without a prompt |
| `--dry-run` | Preview without writing files or starting processes |

`tools zsh cmux install`, `tools zsh cmux status` and `tools zsh cmux uninstall` are the same commands. See
[Automatic capture](#automatic-capture) for what is recorded and how much it keeps.

### Other: `tree`, `send-self`

| Command | What it does |
|---------|--------------|
| `tree` | The live window, workspace, pane and surface tree with pane frames. `--json` |
| `send-self <text>` | Type text into the terminal this process runs in, then press Enter |

`tree` shows no agent sessions; `tools ai cmux tree` adds each surface's session.

`send-self` flags:

| Flag | Meaning |
|------|---------|
| `--no-enter` | Send the text only; leave it unsubmitted at the prompt |
| `--enter-delay <ms>` | tmux only: wait this long between the text and Enter (default `0`) |
| `--target <auto\|tmux\|cmux>` | Force a transport instead of detecting it (default `auto`) |
| `--dry-run` | Print the resolved target and exit without sending |

```bash
tools cmux send-self '/compact'
tools cmux send-self 'text' --no-enter
tools cmux send-self 'text' --dry-run
```

## How it works

### What it talks to and what it needs

- **The cmux app.** The tool changes cmux through the `cmux` CLI and reads the fields the CLI drops (pane geometry,
  browser URLs, window refs) from cmux's Unix socket. [docs/Cmux.md](docs/Cmux.md) is the reference for every cmux
  command and socket method it uses, with the cmux quirks found on the way (verified on cmux 0.63.2).
- **cmux's autosave**, `~/Library/Application Support/cmux/session-*.json`, and the `*-previous.json` file that cmux
  renames aside at each launch. Offline capture, `rescue` and `--source previous` read it.
- **The surface journal**, `~/.genesis-tools/claude-code/cmux-refs.jsonl`. The genesis-tools Claude Code plugin hook
  writes it for Claude, Codex and Grok sessions. It is how a restore knows which session ran in which tab.
- **The pin journal**, `~/.genesis-tools/claude-code/session-pins.jsonl`: the account each session started with.
- **The agent launchers** `tools claude run`, `tools codex run` and `tools grok run`, which start and resume
  sessions. A real restore refreshes the shared session catalog first, which writes to the shared history
  databases; `--dry-run` and `--list` read the cached catalog instead.
- **tmux**, only for `agents new --via-tmux` and for `send-self` inside a tmux pane.

It needs macOS with cmux running, and Bun. Automatic capture needs zsh. Run it from a cmux pane: cmux can refuse
socket connections from processes it did not start (`doctor` reports that as `access-denied`).

The tool makes no paid API call itself. `agents new` and `launch` start agents that spend the chosen account's
subscription budget. `agents new` without `--account` reads the budgets from the usage poller's cache and does not
poll.

### Where data lives

| Path | What it holds |
|------|---------------|
| `~/.genesis-tools/cmux/profiles/<name>.json` | Saved profiles |
| `~/.genesis-tools/cmux/sessions.jsonl` | One line per `agents new` start and close |
| `~/.genesis-tools/cmux/sessions/<name>.pid` | Pid of the shell that runs each session |
| `~/.genesis-tools/cmux/command-journal/` | Captured shell commands |
| `~/.genesis-tools/cmux/screens/` | Cached screens from the collector |
| `~/.genesis-tools/cmux/capture.zsh` | The installed zsh hook |
| `~/.genesis-tools/cmux/runtime/` | Installed runtimes and `installation.json` |
| `~/.genesis-tools/cmux/capture-runtime.log` | Capture diagnostics |
| `~/.genesis-tools/logs/<today>.log` | The GenesisTools day log: each cmux send and each failure |

Profiles are plain JSON. `edit` opens one and `path` tells you where it is, so hand-tuning a layout is expected.

### What a profile restore restores

Three capture behaviors are on by default, and they are what makes a restore feel like a restore:

- **cwd**: each pane comes back in the directory it was in.
- **screen**: each terminal pane's visible content is captured, so the restore paints it back. You see what was on
  screen, not a blank prompt. cmux returns plain text only, so the screen comes back without colors, and only the
  visible rows are captured.
- **history**: the screen is parsed for the most recent shell prompt and command, for example
  `claude --resume <id>`, and that command is **typed at the new prompt**. You press Enter to run it, or edit it
  first. Only prompts with directory, git or host context count: an agent's input box draws a bare `❯` or `$` too,
  and its chat text is not a shell command.

Typing rather than running is deliberate: restoring a layout should not silently run commands again. `--enter`
asks for execution explicitly. The commands go through the same session resolution as `restore-after-restart`
(see below), and the plan prints each pane's command with its drift.

`restore` is always non-destructive: it creates workspaces and never closes yours. It selects each new workspace
while it builds the panes, then returns you to the workspace you were in. `save` reads every workspace in the
background and never switches yours (cmux 0.65 answers reads for background workspaces; 2026-10-14: eleven tabs in
four background workspaces read, focus untouched).

### How restore-after-restart works

There are two modes:

- **`--in-place`** (the usual case): cmux already reopened your tabs as empty shells, with their titles and
  directories. The restore types into those same tabs. Nothing new is created.
- **Default**: rebuild the layout as new workspaces (prefix `restart-`). Use it when cmux did not reopen the tabs,
  or to restore from the pre-restart autosave or a saved profile.

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

The plan says how many tabs it found in the surface journal ("13 of 14 tabs found in the surface journal"). A tab
that stays out of order or wrongly named is listed under the pane restore failures.

#### What `--in-place` types, tab by tab

The plan prints one line per tab: `▶ resume: <command>`, `▶ type (shell command): <command>`, or
`· skip: <reason>`. A tab is typed into only when all of these hold:

- Its surface UUID is in the live layout. cmux keeps the UUID across a relaunch, while the `surface:N` refs are
  renumbered, so the pairing never depends on a ref or a tab position.
- cmux reports the tab's tty. A tab opened in the background and never shown has no tty in `cmux tree` yet; it is
  skipped until you show it once. Right after a relaunch, cmux can report another tab's tty for a tab you have not
  shown yet (seen with cmux 0.65.1: four of fourteen tabs). A tab that shares its tty with another tab, or whose
  renderer has not started (`cmux surface-health`), is judged by its screen alone.
- The session does not already run anywhere. A second `--resume` of a running session forks it, so a session found
  on any tty is skipped with that tty named.
- Its tty runs exactly one process, a shell. A tab with an agent, an `ssh`, a `tail -f`, a second shell (a script
  waiting for input) or any other program is busy and is skipped. When it runs the session the journal names, the
  line says `already runs the recorded session`. When it runs a different agent (cmux's own restore can pick a stale
  session), the skip line names the recorded session.
- It is not the tab running the restore.
- For an agent: a concrete session id is resolved, and the evidence is the surface journal, the session id the typed
  command names, or the tab title (see below). A weaker match, or a path that recorded no evidence at all, is printed
  with its command and never typed.
- cmux could read the tab's screen. An unreadable screen proves nothing about the prompt, so the tab is skipped with
  that reason.
- The last line is a shell prompt the restore knows: `➜ dir git:(branch)`, `[user@host dir]$`, `user@host:dir$`,
  macOS's `user@host dir %`, or a bare `name%`, `$`, `❯`. Only the last line counts: after a relaunch cmux repaints
  the old scrollback (Claude Code's banner included) above the new prompt. A bare glyph counts only while no agent UI
  is on screen, because Claude Code's input box draws `❯` too. Any other last line is skipped and quoted in the plan.

A restore started while the shells are still starting meets shells that run their init, and prompts not drawn yet
("You have mail." as the last line). Those skips are read again up to two more times (three reads in all), 2 s
apart, before the plan is final.

Two preparations run before the command is typed. The plan prints each as `first: …`:

- **Text at the prompt** (`first: clears the prompt line …`): only when the last line is a known prompt with text
  after it. `tools cmux` sends Ctrl-E and Ctrl-U to that tab (`cmux send-key --surface <UUID>`), then waits for an
  empty prompt. If the prompt is still not empty, nothing is typed. zsh keeps the cleared text: Ctrl-Y brings it
  back.
- **A stale grok at its trust prompt** (`first: quits grok …`): cmux's relaunch restore can start an old grok
  session in the tab. While it still asks "Do you trust the contents of this directory?" it has opened nothing, so
  the restore reads the screen again, answers `n`, waits until only the shell is left, and clears the line. A grok
  that is past that dialog is never touched.

Both use the tab's UUID and run in the background: your focused workspace and tab do not change. The in-place
restore never focuses a tab, not even one cmux cannot read yet; only the new-workspace restore (without
`--in-place`) may raise one.

After a resume runs (`--enter`), the restore writes that tab's record to the surface journal, so the next relaunch
finds it even if the agent's own hook did not run. A command that is only typed is not recorded.

#### How each tab's session is chosen

The session is identified by **where it ran**, not by the command you typed. You may start Claude through any
alias, function or wrapper (`cr work`, `ffff`, a shell function), then `/rename` the session: the restore still
resumes the right one. In order:

1. **A live process on the tab's tty** (`claude … --resume <uuid>`): it names the session it runs.
2. **The surface journal** (`~/.genesis-tools/claude-code/cmux-refs.jsonl`). The genesis-tools plugin hook writes
   the session id with the tab's surface UUID at session start and on every prompt, for Claude, Codex and Grok. It
   also writes the workspace, pane and window UUIDs that `cmux identify` reports at that moment, so a tab you moved
   to another workspace is recorded where it is now, not where the agent started. The newest record for the tab's
   UUID wins, with these rules for the tab's last shell command:
   - A worker started inside the tab (a babysit `grok -p`, a Codex app-server) inherits the tab and can write the
     newest line, so the journal keeps the newest session of **each agent** per tab. A launcher that names its agent
     (`grok`, `codex`, `tools codex run`, `cr`) takes that agent's session; any other command (an alias such as
     `ffff`) takes the session the command started first, because workers start later, from inside it.
   - The journal saw the session **after** that command started: the session was the tab's last occupant, so it is
     resumed, whatever the command was. A launcher the code does not know becomes
     `tools claude start <account> -- --resume <id>` (account from the pin journal). The agent's own flags on the
     typed line ride along (`ffff --dangerously-skip-permissions` resumes with `--dangerously-skip-permissions`):
     only flags the agent's `--help` lists, never a model, resume or print flag, and never a wrapper's own flag such
     as `--cross-messages`, which the agent would refuse. The drift line names what was kept and what was dropped.
   - A known launcher whose agent the journal saw only **before** the command started gets no journal session: that
     session belongs to an earlier run in the tab. The drift says so, and the tab title (rule 3) or the session id in
     the command decides.
   - The command started **after** the session's last record (you quit Claude and ran `ssh host`): the command was
     the last thing the tab did, so it is restored instead.
   - `cmux restore <agent> <id>`, which cmux types itself at a relaunch, does not count as your activity. When the
     journal names a different session for the tab, the journal wins.
   - A `tools cmux agents new` line resumes its session. It never sends the first prompt again, which would start
     the whole task a second time.
3. **The tab title**, only when the journal has no record for the tab. An exact title match in the tab's own
   directory wins over sessions whose names extend it (`pr-42-logs` beats `pr-42-logs-scripts`). The drift line
   says `session picked by tab title "…"`.
4. **Weak evidence**: words of the first prompt, or a title match in another directory. It is shown in the drift
   and the plan, and `--in-place` does not type it.

When the typed launcher is a known one, its flags are kept and only the session id is attached:
`cr work --cross-messages` becomes `cr work --cross-messages -- --resume <uuid>`. The wrappers
`tools codex run <account>` and `tools grok run <account>` are known launchers too: the id lands after `--`
(`-- resume <id>` for Codex, `-- -r <id>` for Grok). A typed command that already names a session id keeps it when
the journal has nothing newer.

Any executable under `~/.aliases/` whose body runs `exec tools cc run` or `exec tools claude run` counts as known,
whatever its name. The id lands after `--`, where claude itself reads it; a cc run level `--resume <query>` is a
fuzzy search, so it is replaced by the id.

The account follows the session, not the tab. Claude, Codex and Grok keep a session in its account's home, so the
account it was started with (the pin journal) replaces a different typed account, and the drift line names both.
The typed account stays when the pin agrees or there is none. A `tools cmux agents new` tab resumes through
`tools <agent> run <account>` for all three agents.

Model flags (`-m`, `--model`, `--model=…`) are the exception: every restore drops them, and the drift line says so.
You can switch models inside a session (`/model`), so the model a tab was started with is not the model the session
uses now; without the flag the agent picks its own.

When two tabs resolve to one session id, the tab whose title names the session keeps the resume and the other gets
no command, because a second `--resume` of a running session forks it.

Shell commands come from the local shell journal, so a command you typed inside an `ssh` session is not recorded;
the tab gets the `ssh host` line that started it.

### How rescue works

`rescue` is the destructive counterpart of `doctor`. On a healthy cmux it only warns, and after the confirmation it
still kills and relaunches the app. It runs in this order:

1. Probe cmux and capture an offline profile (autosave plus process table). `--dry-run` stops here, after it prints
   the plan and each pane's command and drift, and saves nothing.
2. Save the profile **before** the confirmation, so an abort still leaves it saved. It never overwrites an existing
   profile: a name that is taken is saved as `<name>-<timestamp>` instead.
3. Ask for confirmation. `--yes` skips it, and in a non-interactive shell `--yes` is **required**: the rescue refuses
   rather than assuming.
4. `SIGTERM` the app, escalating to `SIGKILL` only after a 5 s grace window. When the app still does not exit, the
   rescue stops and relaunches nothing, because replay would type into the livelocked surfaces.
5. Relaunch `/usr/bin/open -a cmux` with only `HOME`, `USER`, `LOGNAME` and `PATH`
   (`/usr/bin:/bin:/usr/sbin:/sbin`) in its environment, so agent markers such as `CLAUDECODE` do not leak into
   every pane's login shell. `open` forwards its environment, and those markers make resumed claudes turn off
   transcript saving.
6. Wait up to 60 s for cmux to answer, then 5 s for the app to reopen its own workspaces, then run the `--in-place`
   restore into the reopened tabs. When cmux does not answer within 60 s, the rescue fails and replays nothing.

The capture is prepared like any restore (title inference, one tab per session, no model pins), and the replay is
the in-place plan above: each tab is paired by its surface UUID, which cmux keeps across the relaunch, and is typed
into only when it is an idle shell with a known prompt and the session has recorded evidence. Unlike
`restore-after-restart`, `rescue` presses Enter on shell commands too (an `ssh` logs back in), as it always did.
Whatever a pane shows afterwards (an account gate, a resume dialog) is reported, never answered.

The recipe `doctor` prints for a starved UI thread is the same sequence by hand: `profiles save rescue --offline`,
`kill -TERM <app pid>` (then `kill -9` if it survives), a relaunch with
`env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin open -a cmux` (never `open -a cmux` from an
agent shell), and `profiles restore rescue --enter`.

### How agent sessions work

`agents new <agent>` opens a workspace in the focused window, in the background unless you pass `--focus true`, and
types `tools <agent> run <account> [-m <model>] [-- <prompt>]` there. The shell writes its own pid to
`~/.genesis-tools/cmux/sessions/<name>.pid` first, so `close` can tell when the agent has quit. The session is
recorded in `~/.genesis-tools/cmux/sessions.jsonl` under its name: the slug of `--name`, or
`<agent>-<folder>-<nonce>`. Two starts with the same name in different processes cannot share a record: the second
waits a moment, then fails. An inline `--prompt` is typed into the terminal, so it is capped at 8 KB; a longer one
goes through `--prompt-file`, which the command reads when it runs (`"$(cat <file>)"`), so it is never typed.

`--repo` takes a path or a folder name. A value that contains `/` or `\`, or starts with `~`, is a path: `~` is
expanded, and a relative path is read from the current directory. Any other value is a folder name under
`~/Tresors/Projects`, matched exactly and then case-insensitively. The folder does not have to be a git checkout.
A name that does not exist fails with the closest matches. So `--repo app` never means `./app`, and `--repo .` is
the Projects folder itself: write `./app` for a folder in the current directory, and `./` for the current
directory.

Without `--account`, `agents new` starts nothing. It lists every enabled account of that agent with its 5h and
weekly budget left, and exits 1. The 5h column shows a dash (`—`) for an account without a 5-hour limit, where the
weekly window decides. The message tells an agent not to choose silently: it must ask the user, or pick the account
with the most headroom and tell the user which one and why.

Claude accepts messages from `tools claude message` by default. That is the `launch.crossSessionInbound` setting
of `tools claude run` (`tools claude config cross-messages`); `--cross-messages` or `--no-cross-messages`
overrides it for one session.

Grok runs inside its account's shared leader (`tools grok run --leader-socket <sock> --session-id <uuid>`; the first
TUI starts the leader, later ones join it). The record's `providers.grok.leader` names the socket and the session
id, so a decision answer reaches the session as an ACP prompt without keystrokes.

`agents list` shows the sessions `agents new` opened that are not closed yet. `--all` adds every other live agent
session in cmux, found through the surface journal; `close` can adopt those. With or without `--all`, a dim line
names live agent tabs the journal has no record of, because a restore could not place them either.

`agents close` quits the agent (`/exit` for Claude and Grok, `/quit` for Codex), waits up to `--grace` seconds, then
closes the workspace. An adopted session (one `agents new` did not open) closes only its surface, because its
workspace may hold other panes. Before each step, `close` checks the recorded UUIDs again, because cmux refs
renumber after a restart. `--force` overrides these refusals: a running turn, a turn state it cannot read, a
workspace with no session record and no agent to adopt, and, for a session `agents new` recorded, a workspace or
surface that is now another one. Some refusals hold even with `--force`: the workspace you run `close` from, a tab
that now runs another agent, a session another `agents` command is starting or closing, a tmux session that proves
to be a different one, and an adopted session whose surface is gone or is now another surface. The report's
outcome is `closed`, `planned` (a dry run), `refused`, or `partial` (the agent did not quit in time, or a tmux
session was left behind). The transcript always stays.

`launch` builds one quoted command line:
`cd <cwd> && tools claude run <account> [-r <query>] [-m <model>] [run-args] -- [-n <name>] [claude-args] <prompt>`.
`--account auto` becomes `tools claude run auto`, which picks the account with the most headroom when the surface
starts. The 8 KB cap on an inline prompt is the cap for a prompt that travels in a link; a `--prompt-file` is read
when the command runs and may be up to 512 KB (half the macOS exec argument limit). With `--open`, the command runs
in a new tab of the focused pane, a split, or a new workspace. The browser-router `cmux-claude` preset turns a
`https://<link host>/cmux/claude/run?prompt=…` link into `tools cmux launch --open`, and a handoff's run link is
minted with `account=auto`. Only Claude has a launcher; another `--agent` name fails and names the file that would
add it (`src/cmux/lib/launchers/<name>Launcher.ts`).

### How send-self works

`send-self` reads `TMUX_PANE` and `CMUX_SURFACE_ID` from the environment. tmux wins when it is nested inside cmux;
`--target` forces one. In cmux, the text and its Enter go out as one `cmux paste --submit` call, so no gap is left
between them, a multi-line text stays one message, and a slash command runs. In tmux, it is `tmux send-keys` for the
text and another for Enter, `--enter-delay` apart. This is the reliable way to make an agent CLI parse a slash
command it did not get from the keyboard: the bytes arrive on the terminal as if typed. For a cmux send, the day log
records the length of the text, never the text itself, because it can be a prompt or a token (a bare slash command
is named in full).

❗ **To fire later, put the sleep in the calling shell, not here.** A long-lived bun process is killed at an agent
turn boundary, so an in-process delay never arrives. Detach it instead:

```bash
nohup zsh -c "sleep 300; tools cmux send-self '/compact'" </dev/null >/dev/null 2>&1 &
```

⚠️ **That form is silent when it fails**, so check first: `tools cmux doctor` prints a `send-self` line saying
whether this surface would accept the keystrokes. A failed send is still recorded in
`~/.genesis-tools/logs/<today>.log` even with stderr discarded.

🛑 **Never pass `--workspace` with a surface UUID or `surface:N` ref.** `cmux send` looks the surface up INSIDE the
workspace you name, so a stale `CMUX_WORKSPACE_ID` (which is what you get the moment a surface is moved to another
workspace) makes the app answer `invalid_params: Surface is not a terminal` about a good terminal. The surface id
alone is unique across the whole tree; `surfaceTargetArgs()` in `src/utils/cmux/lib/target.ts` is the one place that
decides this.

### Automatic capture

Capture records each zsh command and each terminal's screen as they happen, so a restore after a crash has evidence
even when the socket is gone.

```bash
tools cmux capture install             # or: tools zsh cmux install
tools cmux capture status              # or: tools zsh cmux status
tools cmux capture install --no-screens   # commands only, no screen sampling
tools cmux capture uninstall           # stop sampling, remove the rc block, keep the data
```

#### Installing and updating

Installation previews its managed rc block and asks before it edits your zsh rc file. In non-interactive use, and
with `--json` even on a TTY, pass `--yes` to approve that edit. Without it, an rc change is refused: the command
prints the proposed block (`confirmationRequired: true` in JSON) and exits 1. `--dry-run` previews without writing
files or starting a collector. Uninstall follows the same confirmation rule. Repeating installation reports that it
is already installed and does not duplicate or rewrite an unchanged rc block.

The installer generates the hook and the standalone runtimes under `~/.genesis-tools/cmux/`; their source lives in
this repository. Installation and the screen collector need Bun. The zsh command hook uses built-in append and stat
operations and does not start Bun per command. Installed files do not depend on the checkout or worktree staying at
its original path. Existing rc content is backed up before an approved change, and an rc file edited after the
preview is refused. A file that is not UTF-8 is refused too.

Rerun `install` after updating GenesisTools to rebuild the installed files. The stable managed symlink
`runtime/capture-record.js` remains for older loaded recorder-based hooks; updating it refreshes their recorder
without depending on a removable worktree. Current hooks append small NUL-delimited spool records directly, which
the capture reader validates alongside the older JSONL journals. Source changes are not hot-loaded. Changes to
shell functions need the hook sourced again or a new shell, as with a direct symlink to a source script.

New interactive cmux zsh terminals capture automatically. Existing idle shells can reload
`~/.genesis-tools/cmux/capture.zsh`; running agents are not interrupted. Reinstalling the same version is
idempotent. A changed collector version takes over through a new ownership token; the old process exits without PID
signals. Uninstall leaves the shell functions loaded until that shell reloads or exits. `capture shell zsh` stays an
advanced script-generation command; use `install` for a portable managed installation.

The screen collector runs for the current login only. It is not a launchd login service, and nothing restarts it
after a reboot or a crash. Command capture resumes in new zsh shells, but to resume screen sampling, rerun
`tools cmux capture install` (or `tools zsh cmux install`, with the same `--home` and `--rc` if you used them).
`status` tells `enabled, not running` from `running` and prints this recovery advice. Cached screens stay available
while the collector is stopped.

The link between a tab's runtime UUID and cmux's stable id does not depend on screen sampling. A missing link starts
one background resolver, which retries native autosave discovery for up to 30 seconds. Shell events can retry later
at most once per 30 seconds until the link exists. It does not block the command, and it also runs with
`--no-screens`. The resolver needs the installed Bun recorder; the plain command write does not.

#### What is recorded

- The exact local zsh command text and launch directory, written before the command runs. Completion keeps the
  command and its exit status. The write finishes before the command starts, but the spool does not force a disk
  fsync per event, so a sudden power loss can lose recently buffered writes. Pipelines and quotes are kept; tab
  titles are never run as commands.
- The runtime surface UUID, plus cmux's saved `stableSurfaceId` when available. `surface:N` is an in-memory routing
  reference, not a durable id. Workspace ids are for information only: moving a panel does not move its history to
  another panel. A saved link bridges stale shell environment ids; the collector fills links in after native
  autosave supplies a new panel's stable id.
- The current visible terminal text, sampled about every 15 seconds plus collection time, with at most 200 lines or
  200,000 characters per surface. This is a screen snapshot, not a full scrollback recorder. An unchanged screen is
  not written again.
- The native autosave layout: pane proportions, tab order and selection, titles and directories. Native saved text
  and browser URLs are kept when cmux provides them. The screen cache also feeds offline and previous-autosave
  recovery.

The collector reads local socket data only. It never focuses or starts dormant terminals, types commands, launches
agents, or answers dialogs. A socket outage stops that collection pass and leaves the previous cache intact. A
process lock and an ownership token prevent duplicate collectors from the same installation.

#### Resource use and retention

The screen cache has a 64 MiB total budget, previous versions and the pre-restart archive included. The oldest
snapshots are removed when the budget is exceeded. The collector keeps the last cached screens when the native
previous-autosave generation changes, and a historical restore never puts a newer screen in place of an older cutoff.

Command spools keep two bounded generations of about 1 MiB per surface; existing JSONL journals stay readable and
keep their own two-generation limit. Old surface records stay until removed. The hook visibly rejects a command over
65,536 bytes. Runtime diagnostics keep two 1 MiB generations. The files are private local data: folders mode 0700,
new data files mode 0600. Commands and visible output can hold sensitive text, so do not publish the data folder or
copy its contents into test fixtures.

Capture can miss output between samples, terminals that never started, and data older than the retention budget.
It must be installed before a command runs; it cannot recover earlier commands.

#### Covered examples

- `tail -f service.log`, `bun run dev` and CLI monitors: the command, the launch directory, the screen text and the
  surrounding cmux layout are kept. A restore can start the command again when you ask for it.
- `git status`, `tools ai usage` and other finished commands: the last command and its visible output are kept even
  after the process exits.
- Commands with quoted arguments, pipes and several shell statements: the typed shell syntax is kept, not a flattened
  process argument list.
- Moving a terminal between panes or workspaces: the surface link is kept, whatever the workspace or the current
  numbered refs.
- `vim notes.md`, `ssh example-host` or `tmux attach -t example`: the outer launch command and the visible snapshot
  are kept. Application state is not.
- Browser tabs: their saved URL is restored, a browser as the first tab of a pane included, when the URL was
  available to capture.

#### Not covered, or only approximately

- Unsaved editor buffers, cursor and selection state, running process memory, shell-local variables, background job
  state, and exact process ids.
- Commands typed inside an SSH shell, a nested shell or a TUI: only the owning local zsh launch command is captured.
- Browser cookies, form inputs, sign-in flows, navigation history and exact page state.
- Exact window placement, exact pixel and cell sizes from offline estimates, and cmux panels that are not terminals,
  such as project or custom sidebar tools.
- Agent sign-in, resume confirmations, and a second process trying to own a session that already runs elsewhere. A
  restore never confirms these by itself.

Saved terminal text is past output, not proof that its program still runs. By default a restore types the command
for you to check; `--enter` asks for execution explicitly. A launcher that succeeds does not mean the restarted
program returns to the same internal state.

## Configuration

`tools cmux` has no config file of its own. It reads:

- **Environment**: `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` (cmux sets them in each terminal; `send-self` uses the
  surface), `TMUX_PANE` (tmux), `$VISUAL` or `$EDITOR` (`profiles edit`, else `vi`), and `GENESIS_TOOLS_HOME`.
  `GENESIS_TOOLS_HOME` replaces the home folder that holds `.genesis-tools`, the same as `capture --home`: the data
  then lives in `$GENESIS_TOOLS_HOME/.genesis-tools`. The `~/.aliases` lookup and the capture hook follow it.
- **Accounts**: the saved AI accounts (`tools ai config account list`, `tools claude login`). `launch` without
  `--account` uses the default Claude account.
- **Claude launch setting**: `launch.crossSessionInbound`, set with `tools claude config cross-messages`, decides
  whether sessions from `agents new claude` accept cross-session messages.
- **Your launchers**: executables under `~/.aliases/` that run `exec tools cc run` or `exec tools claude run` count
  as known launchers in a restore.
- **Capture**: `--home` and `--rc` choose the home folder and the rc file at install time.

## For agents

- **JSON output**: `doctor --json`, `tree --json`, `launch --json`, `agents new|list|status|close --json`,
  `profiles list|view --json` and `capture install|uninstall|status --json`.
- **Exit codes**: `doctor` exits 1 when cmux is not healthy or `send-self` would not reach this prompt. `tree` exits
  1 when cmux is not available. `agents close` exits 1 on `refused` or `partial` and 2 on a bad `--grace`.
  `agents new` exits 1 without `--account` and 2 on an unknown agent. The restores exit 1 when a pane or tab was not
  restored.
- **Off a TTY**: `profiles save` needs a name and `--scope`; `profiles restore`, `profiles delete`, `rescue` and a
  real `restore-after-restart` need `--yes`; `restore-after-restart` needs `--source` (or `--in-place`), and
  `--profile` with `--source profile`. A missing value prints the command to run with it.
- **Capture rc changes**: `capture install|uninstall` need `--yes` off a TTY and with `--json` when the rc file
  would change. Without it they print the proposed block (`confirmationRequired: true` in JSON) and exit 1.
- **Accounts**: `agents new` never picks an account. Ask the user, or pick the one with the most headroom and say
  which one and why.
- **Fire later**: detach the sleep in a shell (`nohup zsh -c "sleep …; tools cmux send-self '…'" &`) and check the
  `send-self` line of `doctor` first.
- **The manual**: `tools cmux --readme` prints this file.

## Troubleshooting

**A tab says "no session id resolved".**

- `tools claude cmux tree` shows the journal's session for each live tab. A tab without one has no journal record.
- `claude plugin list` must show `genesis-tools@genesis-tools` as `✔ enabled`. The journal hook runs only where that
  plugin loaded. On 2026-10-14 a broken marketplace manifest kept it off for twelve hours, and every session started
  in that time had no journal record.
- `previous` is the file cmux renamed aside on its last launch, not the live layout.
- `--dry-run` and `--list` read the cached session catalog; the real run refreshes it first, so it can resolve a
  session the preview could not.

**`doctor` says `not-running`.** Start cmux from the Dock or Finder, not with `open` from an agent shell: `open`
forwards that shell's environment into every pane.

**`doctor` says `socket-dead`.** The app runs but its socket does not answer. A restart of cmux is likely needed;
`tools cmux rescue` does it safely.

**`doctor` says `access-denied`.** cmux answers but refuses this connection, because only processes started inside
cmux may connect. Run the command from a cmux pane, or change cmux's socket access setting.

**`doctor` says `ui-starved`.** Ping answers but `identify` starves, usually while the app burns CPU. UI clicks and
every state command are stuck. Run `tools cmux rescue`, or the recipe `doctor` prints.

**`profiles save` fails with "live capture is unavailable".** cmux is not healthy, and you asked for a scope other
than `all`, `--no-cwd` or `--no-history`, which offline capture cannot honor. Drop those flags, or pass `--offline`.

**`invalid_params: Surface is not a terminal`.** A send named a stale workspace with the surface. Send to the surface
alone (see [How send-self works](#how-send-self-works)).

**A detached `send-self` never arrived.** Check `tools cmux doctor` (its `send-self` line), and search the day log:
`rg "Surface is not a terminal" ~/.genesis-tools/logs/<today>.log`.

**Screens stopped updating after a reboot.** The collector is not a login service. `tools cmux capture status` shows
`enabled, not running`; rerun `tools cmux capture install`.

**`agents close` refuses.** The agent is in a running turn, its turn state could not be read, the tab now runs
another agent, or you ran `close` from the session's own workspace. The note names which. Wait for the turn to end,
or pass `--force` where the note says so. When the agent did not quit within `--grace` seconds, the
outcome is `partial` and the workspace stays open.

**`rescue` says cmux did not terminate.** It relaunches nothing, so nothing is typed into the stuck app. The profile
is already saved; quit the app yourself, then run the rescue again.

**`rescue` says cmux did not become healthy within 60 s after relaunch.** Nothing was replayed, and the profile is
already saved (`tools cmux profiles list` shows its name). Open cmux, then run
`tools cmux restore-after-restart --in-place --dry-run` and the real restore, or rebuild the saved profile with
`tools cmux profiles restore <name> --enter`.

## Related

- [`tools claude`](../claude/README.md): `tools claude cmux` reopens recent Claude Code sessions as cmux
  workspaces, the session-oriented counterpart of this layout-oriented tool. `tools claude cmux tree` shows each
  tab's journal session.
- [`tools ai`](../ai/README.md): `tools ai cmux tree` is `tools cmux tree` with each surface's agent session.
- [`tools codex`](../codex/README.md) and [`tools grok`](../grok/README.md): the `run` launchers `agents new` and
  restores use.
- [`tools zsh`](../zsh/README.md): `tools zsh cmux install|status|uninstall` is the same capture installer.
- [`tools browser-router`](../browser-router/README.md): its `cmux-claude` preset runs `tools cmux launch --open`
  from a link.
- [`tools tmux`](../tmux/README.md) does the equivalent job for tmux.
- [docs/Cmux.md](docs/Cmux.md): the cmux CLI and socket reference, and the quirks this tool works around.
