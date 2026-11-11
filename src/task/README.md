# tools task

`tools task` runs a command and records every line it prints in an ordered, grep-friendly log, while the command
keeps its terminal behavior (colors, key presses, a dev server's menu). Use it for dev servers (Metro, Vite), long
builds and test runs whose output you, a script or an AI agent must read, follow or wait on later.

## Quick start

```bash
# Run a dev server with capture (a PTY when you start it from a terminal)
tools task run --session metro -- npx react-native start

# Agent onboarding, read this first: state, log files, commands to run next
tools task get --session metro

# Read the last 100 lines
tools task logs --session metro --tail 100

# Follow new lines live (stops by itself when the session ends)
tools task tail --session metro

# Grep the whole log: plain text on stdout
tools task logs --session metro --raw | grep BUNDLE

# Block until the server prints "Bundled", for at most 60 seconds
tools task wait --session metro --exit-on-match "Bundled" --timeout 60
```

## Commands

| Command | What it does |
|---|---|
| `run --session N -- CMD` | Run a command and capture its output |
| `get` | Info panel: state, files, counts, last 10 lines |
| `logs` | Print captured lines, or follow with `--follow` |
| `tail` | Follow captured lines live |
| `wait` | Block until a pattern appears or the session exits |
| `sessions` | List every session with its state and size |
| `stop` | End a session's whole process tree |
| `clean` | Delete a session's files |
| `config` | Show or change retention and GC |
| `dashboard` | Build, serve or open the web log viewer |

Every command that reads a session takes `--session <name>`. You can also put it before the command:
`tools task --session metro logs`. Without it, `get`, `logs`, `tail` and `wait` pick a session for you (see
[Session resolution](#session-resolution)). The global `-v, --verbose` turns on verbose logging, and `--readme`
prints this page.

### run

```bash
tools task run --session <name> [--tty | --no-tty] -- <command> [args...]
```

| Flag | Meaning |
|---|---|
| `--session <name>` | Session name. A terminal asks for it when missing |
| `--tty` | Force PTY mode (macOS and Linux only) |
| `--no-tty` | Force pipe mode |

- Put the command after `--`, so `tools task` does not read the command's own flags.
- The exit code of `run` is the exit code of the command. It is 1 when the command is missing or cannot start, or
  when `--session` is missing outside a terminal.
- Before the command starts, a banner with the log paths and the next commands goes to stderr. At the end,
  `Session <name> ended (code N, 12s)` goes to stderr.
- In a terminal, Ctrl+C reaches the command in both modes.
- At start, `run` deletes old sessions (see [Configuration](#configuration)).
- `--session` with a name that already exists appends to that session. See
  [Session names and reuse](#session-names-and-reuse).

### logs and tail

`logs` prints a snapshot, and `logs --follow` keeps printing new lines. `tail` always follows. Both stop by
themselves when the session ends and print `Session exited (code N).` to stderr. Ctrl+C stops the follow; the
command keeps running.

| Flag | Meaning |
|---|---|
| `-t, --tail <n>` | Last N lines (for `tail`: before it follows) |
| `-H, --head <n>` | First N lines |
| `--head X --tail Y` | First X and last Y lines, with an elision marker between (snapshot only) |
| `--all` | Every line. Wins over `--head` and `--tail` |
| `--from-seq <n>` | Lines from seq N on (inclusive) |
| `--to-seq <n>` | Lines up to seq N (inclusive) |
| `--grep <pat>` | Keep lines that match a case-insensitive regex |
| `--raw` | Only the line text on stdout, safe for `grep` |
| `--jsonl` | The stored JSON records on stdout, safe for `rg` |
| `--stdout` | stdout lines only (default: both streams) |
| `--stderr` | stderr lines only (pipe mode sessions only) |
| `-f, --follow` | Keep printing new lines (the default for `tail`) |

`tail` has two more flags:

| Flag | Meaning |
|---|---|
| `--exit-on-match <pat>` | Print the first line that matches a case-sensitive regex, and exit 0 |
| `--propagate-exit` | Exit with the session's exit code when it ends |

With `--exit-on-match`, `tail` prints only the matching line. It ignores the window and format flags, `--grep`,
`--stdout`, `--stderr` and `--propagate-exit`, and checks the lines of both streams. It exits 0 on a match, or 1 when
the session ends first.

`--grep` is case-insensitive, but `--exit-on-match` (here and on `wait`) is case-sensitive. When you do not know the
case, write a class such as `[Bb]undled`. A leading `(?i)` is not valid in a JavaScript regex: the command exits 1.

Log window defaults:

- In a terminal, `logs` shows the last 50 lines, and `tail` shows the last 10 before it follows.
- When stdout is not a terminal (a pipe, a script, an agent), both default to `--all`, so nothing is cut silently.
- `--grep` implies `--all` unless you also pass `--head` or `--tail`.
- `--from-seq` and `--to-seq` switch the `--head` and `--tail` window off.

Output formats:

- Default: the lines under headers such as `=== [stdout] seq 12 ===`. `logs` prints one header per block of lines
  from one stream and then navigation hints (the commands for earlier and later lines) to stderr. `tail` prints a
  header over every line, so pass `--raw` when you pipe it.
- `--raw`: only the text.
- `--jsonl`: one record per line. With `--head` and `--tail` together, an `{"type":"elision","count":N}` record marks
  the gap. The default and `--raw` formats print `... N lines elided ...` there instead.
- The elision marker appears only in a `logs` snapshot. In follow mode (`tail`, or `logs --follow`), the head and
  tail lines print with no marker between them.

```bash
tools task logs --session metro --all --raw | grep TOKEN
tools task logs --session metro --from-seq 1 --jsonl | rg error
tools task logs --session metro --jsonl | rg '"text".*error'
tools task logs --session metro --head 5 --tail 5 --raw
tools task logs --session metro --stderr --raw | grep -i warning
tools task logs --session metro --tail 100 --follow
```

### wait

`wait` blocks until a pattern appears in the log or the session exits. It replaces the
`until grep -qE …; sleep 5; done` polling idiom.

| Flag | Meaning |
|---|---|
| `--exit-on-match <pat>` | Return when a line matches a case-sensitive regex |
| `--timeout <seconds>` | Give up after N seconds and exit 124 |
| `--print-tail <n>` | Print the last N lines to stdout before exiting (default 0) |
| `--print-exit` | Print `Matched: <line>` or `Session exited (code N).` to stderr |
| `--propagate-exit` | Exit with the command's exit code (only without `--exit-on-match`) |

```bash
# Wait for the dev server's "ready" line, at most 60 seconds
tools task wait --session metro --exit-on-match "Bundled" --timeout 60

# Wait for the session to exit, and exit with its code
tools task wait --session jest --propagate-exit

# Or follow live and exit with the command's code when the session ends
tools task tail --session jest --follow --propagate-exit
```

- Without `--exit-on-match`, `wait` returns when the session exits.
- With `--exit-on-match`, `wait` returns only on a match or at the timeout. It does not return when the session
  exits without a match, so always add `--timeout`. `tail --exit-on-match` exits 1 in that case instead.
- Both read the lines already in the log first. A line from an earlier run of the same session (append mode)
  matches at once.

Exit codes: 0 on a match or a normal exit, the command's code with `--propagate-exit` (143 or 137 after `stop`),
124 on timeout, 1 for an invalid regex, an invalid timeout or a session that does not resolve.

### get

`get` prints an info panel to stderr: the state, the mode, the command, the working directory, the pid, the log
file paths with their sizes, the line counts per stream, the latest seq with its time (ISO, UTC), the last 10 lines,
a flag cheat sheet, and commands to copy. Start here when you come to a session cold. Do not pipe it: all of it is
on stderr.

`--clear-older-than-seq <n>` first removes every line with seq N or lower from the `.jsonl` and `.ui.jsonl` files,
then shows the panel. The `.log` and `.err.log` mirrors keep those lines.

### sessions

`sessions` lists every session with its name, state and `.jsonl` size. The list goes to stderr, so `| grep` sees
nothing. `--json` prints a JSON array to stdout instead, one object per session with `name`, `state`, `command`,
`cwd`, `mode`, `pid`, `jsonlSizeBytes`, `stdoutSizeBytes`, `stderrSizeBytes`, `firstSeq`, `lastSeq` and `jsonlPath`.

### stop

| Flag | Meaning |
|---|---|
| `--session <name>` | Stop one session (fuzzy-matched like `get`, `logs` and `tail`) |
| `--port <n>` | Stop the running session whose process tree holds a TCP listener on that port |
| `--all` | Stop every running session |
| `--timeout <seconds>` | Grace period before SIGKILL (default 5) |
| `--yes` | Skip the `--all` prompt. Required with `--all` outside a terminal |

```bash
tools task stop --session metro              # one session
tools task stop --session metro --timeout 2  # shorter grace before SIGKILL
tools task stop --port 8081                  # whichever session owns this listener
tools task stop --all --yes                  # every running session
```

When you pass more than one selector, `--all` wins, then `--port`, then `--session`.

`stop` sends SIGTERM to the session's whole process tree (every descendant it finds by parent pid, not only the top
pid), waits the grace period, then sends SIGKILL to whatever is still alive. The session state in `.meta.json` is
`stopped`, never a signal's exit code (130 or 143), which would read as if the command chose to exit that way.
`sessions` and `get` show it as `stopped (<duration>)`, distinct from `exited (code N, …)`.

The log is different. The `run` supervisor still appends an exit record with the killed command's code to the
`.jsonl`: 143 after SIGTERM, 137 after SIGKILL. `wait` and `tail` read that record, so after a stop `tail` prints
`Session exited (code 143).`, `wait --propagate-exit` and `tail --propagate-exit` exit 143 (or 137), and the `run`
caller exits with that code too. To tell a stop from a failure, check `get` or `sessions`.

`stop` reads the process table when it starts. Before each signal, it checks that every pid still has the start time
and command line it saw in that table. A pid that changed since then (it was reused, or it ran `exec` during the
grace period) is never signalled. A process that ran `exec` before `stop` started is signalled as usual. When a
changed process is left, a process outlives SIGKILL or a signal is refused, `stop` prints `not stopped` with the live
pids, exits 1, and the session stays running.

Without a flag, a terminal shows a session picker; outside a terminal `stop` exits 1. Exit 0 means stopped, already
finished, or no pid recorded (then the session is only marked stopped).

### clean

- `--session <name>` deletes one session's files.
- `--all` deletes every session. A terminal asks first. Outside a terminal it deletes at once, with no `--yes`.
- Without a flag, a terminal shows a picker; outside a terminal `clean` exits 1.
- `clean` does not stop a running session. Run `stop` first.
- It removes `.jsonl`, `.ui.jsonl`, `.log`, `.err.log` and `.meta.json`. It leaves `.worker.log` (see
  [An agent or a script](#an-agent-or-a-script)).
- `--session` is fuzzy-matched like `stop` (see [Session resolution](#session-resolution)), so copy the exact name
  from `tools task sessions` first. A name that matches nothing exits 1.

### config

```bash
tools task config                               # print the current config (JSON on stdout)
tools task config --session-retention-days 14   # keep sessions for 14 days
tools task config --gc-on-run-start off         # do not delete old sessions on run
```

The keys and defaults are under [Configuration](#configuration).

### dashboard

The dashboard is a web log viewer at `http://localhost:7243`, titled "Log Viewer (dbg + task)". It shows
`tools task` sessions and `tools debugging-master` sessions in one list. `tools task run` does **not** start it.

```bash
tools task dashboard open                      # start the server if needed and open the browser
tools task dashboard open --session metro      # open one session directly
tools task dashboard serve up --foreground     # run the server in the foreground (Ctrl+C to stop)
tools task dashboard serve status              # pid, port, uptime, launchd state
```

| Command | What it does |
|---|---|
| `dashboard open` | Start the server if needed, print the URL and a QR code, open the browser |
| `dashboard build` | Build the frontend (`open` builds it once when it is missing) |
| `dashboard serve up` | Start the server, in the background unless `-f, --foreground` |
| `dashboard serve down` | Stop it (alias `stop`). `--no-force` never escalates to SIGKILL |
| `dashboard serve restart` | Stop it and start it again |
| `dashboard serve status` | Print pid, port, uptime, dependencies, launchd state |
| `dashboard serve logs` | Print the last lines of its background log (`-n`, default 200) |
| `dashboard serve attach` | Follow that log (`-n`, default 50). Ctrl+C detaches only |
| `dashboard serve open` | Like `dashboard open` without `--session`, plus `-q key=value` and `--no-open` |
| `dashboard serve install` | Add a launchd agent, so the server starts at login and restarts on a crash |
| `dashboard serve uninstall` | Remove that launchd agent |

- `dashboard open` takes `--session <name>`, `--port <n>` (default 7243) and `--no-qr`. With `--session`, it
  fuzzy-matches the name first, opens `?source=task&session=<name>`, and prints that URL on stdout. A name that
  does not resolve exits 1 instead of opening another session.
- `serve up`, `serve restart` and `serve install` take `-p, --port <n>` and `--force` (kill a process that holds the
  port). `up` and `restart` also take `--no-open` and `-i, --interactive`. `serve` takes `-i, --interactive` to force
  its menu.
- The server listens on 127.0.0.1 only and has no authentication. `DASHBOARD_BIND_HOST` changes the bind address.
- `tools debugging-master` runs the same server on the same port. Its README describes the HTTP routes. The
  registry of every dashboard port is `src/utils/ui/dashboards.ts`.
- Files: the pid in `~/.genesis-tools/dashboards/debugging-master.pid`, the background log in
  `~/.genesis-tools/logs/debugging-master.bg.log`, the launchd label `com.genesis-tools.log-dashboard`.

## Workflows

### A dev server in your terminal

```bash
tools task run --session metro -- npx react-native start
```

From a terminal, `run` uses PTY mode: Metro keeps its colors and its key menu (`r` reloads). From a second
terminal, or from an agent, read the same session:

```bash
tools task wait --session metro --exit-on-match "Bundled" --timeout 120
tools task logs --session metro --raw --grep "error"
tools task stop --port 8081
```

### An agent or a script

```bash
tools task run --session lint --no-tty -- bun run lint
tools task get --session lint                     # the recorded exit code and the counts
tools task logs --session lint --stderr --raw     # stderr only
```

When neither stdin nor stdout is a terminal (an agent's shell, or `… </dev/null >/dev/null 2>&1 &`), `run` starts
the command in a detached worker:

- The caller still blocks until the command ends and exits with its code.
- The command's output goes to the session log, not to the caller. Read it with `logs`.
- The command survives the caller. When the calling shell dies, the command keeps running; end it with `stop`.
- The worker's stdout and stderr go to `<name>.worker.log`, opened in append mode. It holds the worker's banner
  (useful when the command fails before capture starts) and also a full copy of the command's output, because the
  worker mirrors every chunk to its own stdout and stderr.
- That file grows on every detached run of the same name, and neither `clean` nor the GC removes it, so it outlives
  its session. Delete `~/.genesis-tools/task/sessions/<name>.worker.log` yourself.
- The `ended (code N, 0s)` summary always shows `0s` in this mode. `get` shows the real duration.

### One rolling log per check (append mode)

```bash
tools task run --session tsc --no-tty -- bunx tsc --noEmit
# Later, the same name again: the lines continue at the next seq
tools task run --session tsc --no-tty -- bunx tsc --noEmit
# Drop the first run's lines; the second run's banner prints this command with the right seq
tools task get --session tsc --clear-older-than-seq 1234
```

### When plain `tee` is enough

Use `tools task` when you need ordered stdout and stderr interleaving, seq navigation, the agent-friendly `get`
panel, waiting on a pattern and the dashboard. Use plain `tee` when you only need a single combined file.

## How it works

Nothing here calls a network service, costs money or needs a macOS permission. `stop --port` uses the
[`tools port`](../port/README.md) scanner to find the listener.

### Run modes

- **PTY mode** (`--tty`, or automatic when stdin is a terminal). The command runs in a pseudo-terminal, so it keeps
  colors, follows the window size and gets your key presses. Its output reaches your terminal as usual. The log is
  one merged stream in the order you see it on screen, and every line is recorded as `stdout`, so `--stderr` returns
  nothing. Not on Windows: `--tty` fails there, and automatic mode picks pipe mode.
- **Pipe mode** (`--no-tty`, or automatic when stdin is not a terminal). stdout and stderr stay separate pipes. The
  command's stdout goes to your stdout and its stderr to your stderr, and each log line records its stream. Use it
  for CI and agents, and whenever you need `--stdout` or `--stderr`.

#### Pipe mode and buffering (read this)

In pipe mode, stdout and stderr are separate OS pipes. A child process often **block-buffers stdout** when it is not
attached to a TTY (stderr is usually unbuffered). A script that writes stdout, stderr, stdout in a loop may flush as
one stdout chunk, then all stderr, then the rest of stdout, and that is exactly what the JSONL shows.

`tools task` records lines in the order the chunks **arrive** from the two pipes (a `Promise.race` on both
readers). That order is stable and monotonic (`seq` 1 to N), but it is **not** a faithful replay of the write order
inside a block-buffered child.

For Metro, Vite and other interactive dev servers, prefer PTY mode. Use pipe mode for CI and agents without a TTY,
and use `--stderr` (or `"out":"stderr"` in the JSONL) for stream attribution, not for write-order archaeology.

### Session names and reuse

A session name is the file stem under `~/.genesis-tools/task/sessions/`. A name that would leave that folder
(`../x`) is refused. Use letters, digits, `.`, `_` and `-`, and do not start or end the name with a dot: the dashboard
leaves out a session whose name breaks that rule (`.tmp`, `build.`, `a b`).

- **No `--session`.** A terminal asks for a name. Outside a terminal, `run` exits 1 with
  `error: --session required in non-interactive mode.`
- **A new name.** `run` creates the session.
- **An existing name passed with `--session`.** This is **append mode**, with no prompt. The new run writes into the
  same `.jsonl` and `.log` files, and `seq` continues from the last value. You see:

  ```text
  warn: reusing existing session "foo" (append mode)
  info: last seq 1234; new lines continue from 1235
  info: tail live output: tools task tail --session foo --follow
  info: clear older lines: tools task get --session foo --clear-older-than-seq 1234
  ```

  Append mode suits a re-run of the same logical task (`lint`, `tsc`) when you want one rolling log per check
  name. The earlier exit record is removed, so the session reads as running again. Use `--clear-older-than-seq N`
  on `get` to drop the earlier lines without renaming the session.
- **An existing name typed at the prompt.** A menu offers "Re-use and clear" (empty the files and start again),
  "Re-use and continue" (append mode) and "Prefix and generate session". The last one adds a time suffix,
  `metro-2026-05-26_14-30-22`, and prints two lines to stderr before the banner. The first is
  `note: session "metro" already exists`, then a dash, then `using "metro-2026-05-26_14-30-22"`. The second is:

  ```text
  task-session-id: metro-2026-05-26_14-30-22
  ```

  `get` then shows `Requested: metro (auto-suffixed)` and the related sessions of that base name.

### Session resolution

`get`, `logs`, `tail` and `wait` find a session this way. `stop`, `clean` and `dashboard open` use step 1 only.
Without `--session`, `stop` and `clean` show a picker in a terminal and exit 1 outside one, and `dashboard open`
opens the viewer with no session selected.

1. With `--session <name>`: the exact name, else the closest fuzzy match among all sessions (`metro` finds
   `metro-2026-05-26_14-30-22`). With no match, the command exits 1 and lists the names.

   The match is case-insensitive. It tries an exact name, then a prefix, then a substring, then any name that holds
   the letters in order (`lnt` finds `lint`). When two names score the same, the first one in the directory listing
   wins, not the newest. `stop --session` and `clean --session` match the same way, so `clean --session lnt`
   deletes `lint`. Copy the exact name from `tools task sessions` before you stop or clean.
2. Without `--session`: the last session you ran or named, if it is still running; else the only running session;
   else exit 1 with `No active sessions` or `Multiple active sessions` (and a `get` command for each). The tool
   prints `(auto-resolved session: <name>)` to stderr.

"Running" in step 2 means no exit recorded and started less than one hour ago. A dev server that has run for longer
than an hour is not picked by itself; pass `--session`. `tools task sessions` lists the exact names.

### Session states

| State | Meaning |
|---|---|
| `active (running 3m 12s)` | No exit recorded, and the recorded process is alive |
| `exited (code N, 1m 4s)` | The command ended |
| `stopped (1m 4s)` | `tools task stop` ended it |
| `unknown` | The tool cannot read the session's metadata |

`run` records the command's pid with its command line and start time. When that pid is gone, or now belongs to
another program, and no exit record exists (for example after `tools task` itself crashed), the session is marked
`exited (code 130)`. A command that runs `exec` or renames itself keeps its `active` state, because the start time
still matches.

### Files on disk

Everything lives under `~/.genesis-tools/task/`:

| File | Content |
|---|---|
| `sessions/<name>.jsonl` | The canonical ordered log: a `meta` record, `line` records, an `exit` record |
| `sessions/<name>.ui.jsonl` | ANSI copy for the dashboard only (same `seq`); CLI commands never read it |
| `sessions/<name>.log` | stdout lines, ANSI stripped, for grep |
| `sessions/<name>.err.log` | stderr lines, ANSI stripped |
| `sessions/<name>.meta.json` | State: command, cwd, mode, pid, exit code, stop time |
| `sessions/<name>.worker.log` | A detached worker's banner and a copy of the command's output (see below) |
| `config.json` | Retention settings and the last used session |

`clean` and the GC remove the first five files of a session. They never remove `<name>.worker.log`. Every detached
run of that name appends to it, so it grows without limit and outlives its session. Delete it by hand.

A line record in the `.jsonl` (one line in the file, wrapped here):

```json
{"type":"line","seq":42,"out":"stderr","level":"warn","ts":1762700000000,
 "text":"WARN old flag","raw":"\u001b[33mWARN\u001b[0m old flag"}
```

- `seq` rises by one per line and never repeats in a session.
- `out` is the stream (always `stdout` in PTY mode).
- `level` is `error`, `warn` or `info`, guessed from the text (an `Error:`, a stack frame, a `WARN`), not from the
  stream. A line on stderr is not an error for that reason alone.
- `ts` is epoch milliseconds. `text` has the ANSI codes stripped; `raw` keeps them.
- The exit record looks like `{"type":"exit","code":0,"durationMs":5120,"ts":"2026-11-09T10:00:00.000Z"}`.

### I/O contract

| Goes to **stdout** | Goes to **stderr** |
|---|---|
| `--jsonl` records | The run banner and the exit summary |
| `--raw` log text | Tips and navigation hints |
| Default `logs` and `tail` content | The `get` info panel |
| Command output on `run` | The command's stderr on `run` (pipe mode) |
| `sessions --json`, `config` | The plain `sessions` list |
| `wait --print-tail` lines | `(auto-resolved session: …)` and errors |

**Why:** pipes and `grep` only see stdout. Tips on stderr never break `| grep` or `| tee`. Shell redirection such
as `2>&1 | tee own.log` still works on `run`.

## Configuration

`~/.genesis-tools/task/config.json`, written by `tools task config`:

| Key | Default | Meaning |
|---|---|---|
| `sessionRetentionDays` | `30` | The GC deletes a session whose `.jsonl` was last written over N days ago |
| `gcOnRunStart` | `true` | Run that GC at the start of every `tools task run` |

- The GC skips a session whose process is still alive. Manual removal is `tools task clean --all` or
  `tools task clean --session <name>`.
- The GC looks only at `.jsonl` files and removes the same files as `clean`. It leaves every `<name>.worker.log`
  behind; delete those in `~/.genesis-tools/task/sessions/` yourself.
- `0` days is allowed, and it deletes every finished session at the next `run`.
- The same file holds `recentSession`, the last session you used. `config` keeps every key it does not own.
- When the file cannot be read, is not JSON or has a wrong value, `run` uses the defaults with the GC **off**, so it
  never deletes by a retention you did not set. `config` refuses to write over a file that does not parse.

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_HOME` | Moves the data root to `$GENESIS_TOOLS_HOME/.genesis-tools/` |
| `TASK_CONFIG_PATH` | Another file for the two retention keys (`recentSession` stays in `config.json`) |
| `DASHBOARD_BIND_HOST` | The dashboard server's bind address (default `127.0.0.1`) |
| `TASK_RUN_WORKER` | Set by `run` on its detached worker. Do not set it yourself |

## For agents

- Start with `tools task get --session <name>`. It shows the state, the recorded exit code and the commands to run.
- Pipe `logs` with `--raw` or `--jsonl`. Outside a terminal, `logs` and `tail` already default to `--all`.
- Use `wait --exit-on-match ... --timeout N` instead of a sleep loop.
- `run` exits with the command's code. When you read `$?`, make `run` the last command on the shell line.
- After `stop`, the log still records the signal's code, so `run`, `wait --propagate-exit` and
  `tail --propagate-exit` report 143 or 137. `get` and `sessions` show `stopped`: check them before you call it a
  failure.
- Machine-readable output: `sessions --json`, `logs --jsonl`, `config`.
- The plugin skill is `genesis-tools:task` (`plugins/genesis-tools/skills/task/SKILL.md`). The tool has no MCP
  tools.

| Command | Exit code |
|---|---|
| `run` | The command's code. 1 when it is missing, cannot start, or has no `--session` outside a terminal |
| `get`, `logs`, `tail` | 0. 1 when no session resolves, or on an invalid flag value (see below) |
| `tail --propagate-exit` | The session's exit code (143 or 137 after `stop`) |
| `tail --exit-on-match` | 0 on a match, 1 when the session ends first |
| `wait` | 0 on a match or an exit, the command's code with `--propagate-exit`, 124 on timeout |
| `stop` | 0 when stopped or already finished. 1 when not found or not stopped (see below) |
| `clean` | 0. 1 when `--session` does not resolve, or without a flag outside a terminal |
| `config` | 0. 1 on an invalid value, or a config file that does not parse |

- An invalid flag value for `get`, `logs` and `tail` is a `--grep` or `--exit-on-match` pattern that is not a valid
  regex, or a `--clear-older-than-seq` that is not a number.
- `stop` also exits 1 on a `--timeout` that is not a positive number, a `--port` that is not a number or that no
  running session listens on, and, outside a terminal, with no flag or with `--all` but no `--yes`.

## Troubleshooting

- **`--stderr` prints nothing.** The session ran in PTY mode, which merges the streams. Run it with `--no-tty`.
- **Lines come out of order in pipe mode.** The command block-buffers stdout. See
  [Pipe mode and buffering](#pipe-mode-and-buffering-read-this).
- **`error: --session required in non-interactive mode.`** Pass `--session <name>` to `run`.
- **`No active sessions` or `Multiple active sessions`.** Pass `--session`. Auto-resolution sees only running
  sessions that started less than one hour ago.
- **`--session metro` reads the wrong session.** No session is named exactly `metro`, so the fuzzy match picked
  another one. `tools task sessions` lists the exact names.
- **`wait --exit-on-match` returns at once.** A line from an earlier run of the same session matched (append mode).
  Clear the old lines with the `--clear-older-than-seq` command the banner printed, or use a new name.
- **`wait --exit-on-match` never returns.** The session ended without a match. Add `--timeout`, or use
  `tail --exit-on-match`, which exits 1 when the session ends.
- **A session shows `exited (code 130)`, but nobody pressed Ctrl+C.** Its process died without an exit record, and
  the tool marked it exited.
- **`stop` prints `not stopped`.** A process could not be proven to be the task's (it ran `exec` while `stop` ran, or
  its start time could not be read), outlived SIGKILL, or refused the signal. The session stays running. Check the
  listed pids with `ps` and end them yourself.
- **Old sessions are never deleted.** `gcOnRunStart` is off, or the config file cannot be read, which turns the GC
  off too. Fix or remove `~/.genesis-tools/task/config.json` until `tools task config` shows `"gcOnRunStart": true`.
- **The dashboard does not list a session.** Its name has characters other than letters, digits, `.`, `_` and `-`,
  or it starts or ends with a dot.
- **`wait --propagate-exit` exits 143 after a `stop`.** The log's exit record keeps the signal's code. `get` shows
  `stopped`.
- **The sessions folder keeps growing after `clean`.** `<name>.worker.log` files stay behind. Delete them by hand.
- **The first `dashboard open` is slow.** It builds the frontend once (`bunx vite build`).
- **Port 7243 listens, and you did not start it.** It is most likely the same server, started by
  `tools debugging-master`. `tools task dashboard serve status` shows its pid.

## Related

- [`tools debugging-master`](../debugging-master/README.md): the same log dashboard and server; its sessions show
  beside task sessions.
- [`tools port`](../port/README.md): find what listens on a port. `tools task stop --port` uses its scanner.
