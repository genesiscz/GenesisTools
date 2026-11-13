# tools tmux

List, create, attach, reset and snapshot the sessions of your default tmux server. Use it to start named sessions
in the right folder, see what every pane runs, save the whole set as a named preset, and rebuild sessions after a
reboot or a server that went wrong.

These commands lived under `tools cmux tmux` until 2026-06-03, and that group no longer exists. `tools cmux` owns
cmux workspace profiles; this tool owns plain tmux sessions. The tmux code itself is in `src/utils/tmux/`, which the
dev-dashboard server shares.

## Quick start

```bash
tools tmux sessions                                    # every session as a tree: windows, panes, folders, branches
tools tmux create --name app --cwd ~/Projects/app      # a detached session that starts in that folder
tools tmux attach app                                  # attach by exact name, or pick from substring matches
tools tmux presets save daily --note "before upgrade"  # snapshot every session into the preset "daily"
tools tmux presets restore daily --dry-run             # show what a restore would create, change nothing
tools tmux session reset app                           # back up, kill and rebuild one session
```

## Commands

Global options: `-v, --verbose` (debug logging), `-V, --version`, `--readme`, `-h, --help`.

"Without a TTY" below means standard input is not a terminal: a script, a pipe or an agent.

### List sessions

```
tools tmux sessions [--json] [--no-detailed] [--prefix <str>]
```

| Option           | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `--json`         | Print JSON instead of the tree (shapes under "For agents").       |
| `--detailed`     | The default: windows and panes with their details.                |
| `--no-detailed`  | One line per session. Faster.                                     |
| `--prefix <str>` | Only sessions whose name starts with `<str>`.                     |

The detailed tree prints one header per session, `app (attached, 2 windows · ttyd :7681)`, then each window and
pane. Under a pane, `cwd:` is its folder and git branch, `cmd:` is the program it runs, and `last:` is the last
command typed at its prompt. The `ttyd` parts appear when a dev-dashboard browser terminal shows the session.

`tools tmux session` with no subcommand prints the same detailed tree and the help of the `session` group.

### Create a session

```
tools tmux create [-n <name>] [-c <path>] [--command <shell>] [-a]
tools tmux sessions create [-n <name>] [-c <path>] [--command <shell>] [-a]
```

Both lines are the same command with the same options. The session starts detached and shows up in the
dev-dashboard tmux hub.

| Option              | Default                   | What it does                                |
| ------------------- | ------------------------- | ------------------------------------------- |
| `-n, --name <name>` | `cmux-` + 8 hex chars     | Session name. An existing name is an error. |
| `-c, --cwd <path>`  | the current folder        | Folder of the first pane.                   |
| `--command <shell>` | `$SHELL`, else `/bin/zsh` | What the first pane runs.                   |
| `-a, --attach`      | off                       | Attach right away. Needs a TTY.             |

Without `--attach` it prints one JSON line, for example
`{"sessionName":"app","cwd":"/tmp/app","command":"/bin/zsh"}`.

How `--command` runs:

- One word that names a program (`htop`, `/bin/zsh`) runs as it is.
- Anything else (spaces, quotes, `;`) is a command line. It runs as `$SHELL -lic '<line>'`, so your `.zshrc` aliases
  work. The pane stays open after the command ends (`remain-on-exit`), so you can read its output.
- When a command line exits with an error or a signal in its first second, the tool kills the session and the error
  shows the pane's last lines, instead of reporting a session that does not work.
- `--attach` without a TTY still creates the session, then fails and tells you to run
  `tmux attach-session -t <name>` yourself.

### Attach

```
tools tmux attach <query>
tools tmux session attach <query>
```

Both lines are the same command. A session whose name equals `<query>` wins. Otherwise the tool matches
`<query>` as a substring:

- One match: it attaches. Detach with your tmux prefix and `d` (`C-b d` by default) to get back.
- Several matches: a picker in a terminal. Without a TTY it prints the matches and every session, and exits 1.
- No match: it prints every session and exits 1.
- Without a TTY it never attaches. It names the session it resolved and prints `tmux attach-session -t <name>`.

### Reset a session

```
tools tmux session reset <sessionId> [-y] [--skip-replay] [--preset <name>] [--skip-backup]
tools tmux session reset --matching <prefix> [-y] [--skip-replay] [--preset <name>] [--skip-backup]
```

`<sessionId>` is the exact session name. `--matching` takes every session whose name starts with `<prefix>` (a plain
prefix, not a glob). Give one of the two, never both.

| Option                | What it does                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `--matching <prefix>` | Reset every session whose name starts with `<prefix>`.               |
| `-y, --yes`           | Skip the confirmation.                                               |
| `--skip-replay`       | Do not type each pane's last command at the new prompt.              |
| `--preset <name>`     | Name of the backup preset (default `reset-<name or prefix>-YYYYMMDD-HHMM`).    |
| `--skip-backup`       | Write no backup preset. Riskier; meant for tests.                    |

What a reset does, in order. It expects window 0 and pane 0 (see Troubleshooting if you set `base-index`):

1. It snapshots the sessions and prints the plan. It warns when a session is attached, because the kill
   disconnects every client of it.
2. It asks for confirmation (default No). Without a TTY it refuses unless you pass `--yes`.
3. It writes a backup preset, for example `reset-app-20261109-1430` (local time). Characters outside
   `A-Z a-z 0-9 . _ -` in the name become `_`. A backup of the same name is overwritten. If the write fails, the
   reset stops before it kills anything.
4. It cleans the tmux server's environment (see "The tmux server" below), so the rebuilt panes render in color.
5. It kills the sessions and rebuilds each one from the snapshot, as `presets restore` does. It prints the
   restored, skipped and failed counts and the command that restores the backup:
   `tools tmux presets restore reset-app-20261109-1430`.

### Presets

A preset is a named snapshot of sessions, windows and panes, saved as a JSON file.

```
tools tmux presets save [name] [--prefix <str>] [-f] [--skip-history] [--note <text>]
tools tmux presets list [--json]
tools tmux presets restore <name> [-y] [--dry-run] [--only <prefix>] [--suffix <str>] [--skip-replay]
tools tmux presets delete <name> [-y]
```

`presets save [name]` snapshots every live session into a preset. The default name is `snap-YYYYMMDD-HHMM` (local
time). A name may hold letters, digits, dots, underscores and dashes only. It fails when no session matches.
Two unnamed saves in the same minute get the same name, so the second one fails unless you pass `-f` or a name.

| Option           | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `--prefix <str>` | Only capture sessions whose name starts with `<str>`.              |
| `-f, --force`    | Overwrite a preset of the same name. Without it, that is an error. |
| `--skip-history` | Do not read pane scrollback for the last command. Smaller, faster. |
| `--note <text>`  | Store a free-form note on the preset.                              |

`presets list` prints every preset sorted by name, with its capture time, its session, window and pane counts, its
note and its file. With no presets it prints the folder it looked in. `--json` prints the same as JSON.

`presets restore <name>` prints the plan, asks for confirmation (default Yes), then creates the sessions. A
session whose name is already taken is skipped, never replaced. One failed session does not stop the others.

| Option            | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `-y, --yes`       | Skip the confirmation. Required without a TTY.                      |
| `--dry-run`       | Print the plan, change nothing.                                     |
| `--only <prefix>` | Only sessions whose saved name starts with `<prefix>`.              |
| `--suffix <str>`  | Add `<str>` to each new session name, to restore beside originals.  |
| `--skip-replay`   | Do not type each pane's last command at the new prompt.             |

`presets delete <name>` deletes the preset file after a confirmation (default No). Without a TTY it needs `--yes`.

## How it works

### What a preset holds

A preset is one JSON file, format version 1. For each session it holds the name, the folder, whether a client was
attached, and the windows with their index and name. For each pane it holds:

- the index and the folder;
- the program tmux reports (`currentCommand`);
- the full command line of the pane's foreground process, found through the process table, for example
  `claude --resume <id>` (`launchCommand`);
- the last command typed at a prompt (`lastShellCommand`). The tool reads the pane's screen and the 200 history
  lines above it, finds the last prompt line (`$`, `#`, `%`, `❯` or `➜` followed by text) and keeps the prompt line
  and up to four continuation lines (five lines at most). It drops lines that look like mouse escape codes, prompt
  remnants or agent status lines. In
  an interactive program such as Claude Code or vim, the line it finds is often text you typed into that program.

### What a restore rebuilds

- One session per saved session, with the same windows, window names and pane count.
- The first pane of each session runs your shell (`$SHELL`) in its saved folder. The other panes and windows start
  tmux's `default-shell`.
- Each pane gets its saved last command typed at the prompt, without Enter. Read it and press Enter yourself, or
  clear it. `--skip-replay` leaves every prompt empty.
- It does not run the saved foreground command (the `cmd:` line) again, and it does not keep pane sizes or the
  layout: the panes come back as plain splits.

### The detailed listing

- `sessions` reads every pane's scrollback and runs `git rev-parse --abbrev-ref HEAD` once per distinct pane folder.
  That is the cost `--no-detailed` skips.
- `cmd:` shows the foreground command line when it means something, else the program tmux reports.
- `last:` is hidden when the pane runs a full-screen program (`claude`, `vim`, `nvim`, `less`, `htop`, `nano`) or
  was started as Claude Code (`claude`, `claude-code`, `tools cc`). There the scrollback is that program's screen,
  not shell history.
- The `ttyd` parts come from `ttydSessions` in `~/.genesis-tools/dev-dashboard/config.json`, matched by tmux
  session name. A row whose ttyd process is gone is skipped. When that file is missing or unreadable, the listing
  works without them and the reason goes to the debug log.

### The tmux server

- The tool passes no `-L` or `-S`, so outside tmux it talks to the default server only, and sessions on another socket
  do not show. Run from inside a tmux pane, it uses that pane's own server (from `$TMUX`), even on another socket.
- It finds tmux on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`.
- Every command that creates a session (`create`, `presets restore`, `session reset`) also pins the server. In the
  server's global environment it unsets `NO_COLOR`, `CARGO_TERM_COLOR` and `PIP_NO_COLOR`, and sets
  `COLORTERM=truecolor`, `FORCE_COLOR=1`, `CLICOLOR=1` and `CLICOLOR_FORCE=1`. It also unsets the test-sandbox
  variables a `bun test` run leaves in a server it started. It turns off `exit-empty` and `destroy-unattached`, so
  the server stays up after its last session ends.
- tmux gives every new session the environment of the process that started the server. `session reset` cleans it
  before the kill, so the rebuilt panes do not inherit `NO_COLOR` from that process.
- The first pane of every session the tool creates (`create`, and the first pane of each restored session) does not
  get the variables that belong to another program: agent session ids (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and
  others), cmux and Ghostty surface ids, and the GenesisTools test markers. Extra panes and windows of a restore or
  reset start tmux's default shell with the server's global environment, so they can still carry those variables when
  an agent or a test run started the server. On 2026-10-16 a server that a test run inside an agent had started
  handed `GENESIS_TOOLS_TEST_RUNTIME=1` to every dashboard terminal for a day.
- When no server runs, the first command that creates a session starts the server from your home folder. A server
  keeps the folder it started in, and on tmux 3.7c a server whose folder was later deleted put every new pane there
  and ignored `-c` (measured 2026-09-26).
- Every tmux call except the attach has a 10 s limit. A watchdog in the child process tree also kills a stuck tmux
  client after 8 s, even when this tool is killed first, so no client is left spinning.

### Where data lives

- Presets: `~/.genesis-tools/cmux/tmux-presets/<name>.json`, written atomically. The folder keeps the old cmux path
  so presets saved before the move still load; the data is plain tmux. Reset backups go to the same folder.
- The dev-dashboard's `/tmux-presets` page reads and writes the same folder.
- Apart from the shared GenesisTools run logs (`~/.genesis-tools/logs/`, with a record of each failed run), the tool
  writes nothing else, makes no network calls and costs nothing.
- It needs tmux (`brew install tmux`), and git for the branch names in the tree.

## Configuration

There is no config file. These environment variables matter:

- `SHELL`: the default `--command` of `create`, and the shell every restored pane starts. The fallback is
  `/bin/zsh`.
- `GENESIS_TOOLS_HOME`: moves `~/.genesis-tools`, and with it the preset folder.
- `TMUX`: set inside a tmux pane; the tool passes it on, so it reaches that pane's server.
- `TMUX_TMPDIR`: the folder of the default tmux socket.

## For agents

- `tools tmux sessions --json` (detailed, the default) prints an array of sessions:
  `{name, cwd, attached: boolean, windows: [{index, name, panes: [{index, cwd, currentCommand, launchCommand,
  lastShellCommand, branch}]}], ttyd: [{id, port, label, cwd}]}`.
- `tools tmux sessions --json --no-detailed` prints `{name, attached, windows, command, cwd, title, created,
  lastActivity, ttyd}`. Here `attached` is the number of clients, `windows` is a count, and `created` and
  `lastActivity` are Unix seconds. `attached` and `windows` change type between the two modes.
- `tools tmux presets list --json` prints `[{name, capturedAt, sessions, windows, panes, bytes, note, path}]`.
- `tools tmux create` prints one JSON line `{sessionName, cwd, command}`.
- Without a TTY, `session reset`, `presets restore` and `presets delete` exit 1 unless you pass `--yes`, and the
  error prints the command with `--yes` added. Preview a restore with `--dry-run` first.
- An agent cannot attach. `attach`, `session attach` and `create --attach` exit 1 and print the
  `tmux attach-session -t <name>` command for a person to run.
- Exit codes: 0 on success, 1 on any error or refusal. A restore or reset where one session failed also exits 1.
- There is no MCP tool and no plugin skill for this tool.

## Troubleshooting

- **`(no tmux sessions)` while tmux runs.** The tool sees the default socket only, so a server started with
  `tmux -L <name>` is invisible. A server that does not answer within 10 s also reads as no sessions, and so does a missing tmux binary
  (listing never prints the `tmux not found` error). Check with `tmux ls` and `which tmux`. Inside a tmux pane the
  tool uses that pane's server.
- **`tmux not found (checked PATH and /opt/homebrew/bin, /usr/local/bin, /usr/bin)`.** Install tmux with
  `brew install tmux`.
- **`tmux rename-window failed`, `split-window failed` or `send-keys failed` (can't find window) during a restore or
  reset.** Your tmux.conf sets `base-index` or `pane-base-index` to a value other than 0. Restore and reset expect
  window 0 and pane 0. A reset has already killed the original session by then, so you are left with a one-pane
  session and exit 1. Set both options back to 0, or do not reset sessions with this tool.
- **`Pass --yes to skip the confirmation in non-interactive mode.`** A script or an agent ran `session reset`,
  `presets restore` or `presets delete`. Add `--yes`, after a `--dry-run` for a restore.
- **`Attaching needs a TTY` or `--attach needs a TTY`.** Run the printed `tmux attach-session -t <name>` in a
  terminal.
- **`tmux attach-session exited with code 1` inside tmux.** tmux refuses to nest a session in a pane of another
  one ("sessions should be nested with care"). Switch the current client instead: `tmux switch-client -t <name>`.
- **`tmux session <name>: the command exited with status <n>`.** The `--command` of `create` failed in its first
  second. The session is gone, and the message holds the pane's last lines.
- **`Preset "<name>" already exists. Use --force to overwrite.`** Pick another name, or pass `-f`.
- **`Invalid preset name`.** Use letters, digits, dots, underscores and dashes only, no slashes.
- **`Preset "<name>" has version <n>; this CLI only supports version 1.`** The file was written by another version
  of the tool.
- **`Backup write failed: … Aborting`.** The reset killed nothing. Fix the cause (a full disk, a bad `--preset`
  name), or pass `--skip-backup` if you accept losing the layout.
- **A restored pane shows a strange command at the prompt.** It came from an interactive program's screen, not
  from the shell. Clear the line, or restore with `--skip-replay`.
- **The restore plan skips a session because it already exists.** A session with that name is alive. Restore
  with `--suffix -restored`, or kill the original first.
- **A reset disconnected a terminal.** The reset kills attached sessions; the plan warns about this. Reattach with
  `tools tmux attach <name>`.

## Related

- [`tools cmux`](../cmux/README.md): cmux workspace profiles, and `agents new --via-tmux`, which runs an agent in a
  detached tmux session.
- [`tools dev-dashboard`](../dev-dashboard/README.md): browser terminals (ttyd on tmux), the tmux hub, the
  `/tmux-presets` page on the same preset folder, and `/quick-commands`, which runs snippets in tmux.
- [`tools claude`](../claude/README.md): `tools claude start --tmux` launches Claude Code in a new tmux session.
