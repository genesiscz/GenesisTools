# tools daemon

The GenesisTools background scheduler. One launchd job runs shell commands on a schedule ("every 10 minutes",
"every day at 03:00") with a timeout, retries, a CPU priority and a rule for runs the Mac missed while it slept.
Other tools put their background work here (AI usage polling, the hub brief, disk indexing), and every run is
logged, so you can see what failed and why.

## Quick start

```bash
# Install the launchd job: the daemon starts now and at every login
tools daemon install

# Is the daemon running, and which tasks does it have?
tools daemon status

# What failed in the last 24 hours, with the last stderr lines of each failure
tools daemon stats --view failures

# Run one task now, by hand, and print its run id
tools daemon run ai-usage-poll

# Run a task at background priority (the daemon applies it on its next tick)
tools daemon config set hub-memo-scan --priority low

# Open the menu: status, tasks, logs, start, stop, launchd
tools daemon
```

## Commands

Global flags: `-v, --verbose` (verbose logging), `--readme` (print this page), `-V, --version`.

### The daemon process

| Command | What it does |
|---|---|
| `install` | Writes and loads the launchd plist: the daemon starts now, at login, and again after any exit |
| `uninstall` | Unloads the launchd job and deletes its plist |
| `start` | Runs the scheduler in this terminal (Ctrl+C stops it). Refuses when launchd already runs the daemon |
| `stop [--uninstall]` | Stops the daemon; launchd restarts it at once. `--uninstall` also removes the job (see below) |
| `restart` | Stops the launchd daemon and waits up to 10 s for launchd to start a new one. Needs `install` first |
| `status [--json]` | Whether the daemon runs (launchd or foreground), its PID, and every task with its schedule |

`install` is safe to run again: it unloads the old job, writes the new plist and loads it. When the load fails, it
writes the previous plist back and loads that, so a failed reinstall never leaves you with no job.

`stop` and `restart` stop the process in steps: a SIGTERM, a second SIGTERM after 8 s, then a SIGKILL after 4 s more.
`stop` reports which step ended it; `restart` prints the old and the new PID.

`stop --uninstall` removes the job only while the daemon runs. When `stop` says "Daemon is not running." (for
example between two launchd restarts in a crash loop), `--uninstall` does nothing and the plist stays. Run
`tools daemon uninstall` then.

### Tasks

| Command | What it does |
|---|---|
| `config list [--json]` | Every task with its state, schedule, retries, priority, missed-run rule and command |
| `config set <name> [flags]` | Changes a task's settings (flags below); the daemon applies them on its next tick |
| `config add` | Asks for a new task in the terminal: name, command, schedule, retries, description, retention |
| `config remove <name>` | Deletes the task from the config. Its run logs stay on disk |
| `config enable <name>` | Turns a task on |
| `config disable <name>` | Turns a task off. It keeps its settings; the daemon skips it until you enable it |
| `run <name> [--json]` | Runs the task once now, with its timeout and priority, no retries; logged as `manual` |

`config set` flags:

| Flag | Values |
|---|---|
| `--every <expr>` | The schedule, for example `"every 5 minutes"` or `"every day at 03:00"` |
| `--timeout-ms <ms>` | Kill a run after this many ms (at least 1000). `default` restores 10 minutes |
| `--retries <n>` | Extra attempts after a failed run, 0 to 10 |
| `--enabled [on\|off]` | Turn the task on or off |
| `--notify [on\|off\|failure]` | macOS banners for every run, never, or only failures |
| `--priority [high\|normal\|low]` | Child QoS and start order (see Priority below) |
| `--missed-run [asap\|on-wake\|retry-at\|skip]` | Daily tasks: what a run missed while the Mac slept does |
| `--retry-at <times>` | Comma-separated `HH:MM` times; implies `--missed-run retry-at` |
| `--description <text>` | A one-line description |
| `--json` | Print the updated task as JSON |

A flag that takes a choice, given with no value, prints the possible values and exits 1. `--missed-run asap` removes
the rule, since `asap` is the default. `--priority normal` is stored, so a tool that registers its task again keeps
it.

```bash
# Only tell me when the nightly scan fails, and give it 30 minutes
tools daemon config set macos-clones-scan --notify failure --timeout-ms 1800000

# A daily task missed during sleep runs at 10:00, and a failed run tries again at 12:00
tools daemon config set daily-digest --retry-at 10:00,12:00

# Turn a task off without removing it
tools daemon config set hub-memo-scan --enabled off
```

`config add` needs a terminal. A task name there is letters, digits, `-` and `_`, and must not exist yet. A task it
creates sends banners for every run until you set `--notify failure` or `off`.

`run` works whether or not the daemon runs, and also runs a disabled task. It runs in the calling process and does
not check whether the daemon is running the same task at that moment. It exits 0 when the command exited 0, else 1,
and prints the command to see the output (`tools daemon stats --view run --run <id>`).

### Logs and statistics

| Command | What it does |
|---|---|
| `logs` | A menu: pick a task, then one of its runs, and read its output |
| `logs -t, --task <name>` | Prints the newest run of one task: command, attempt, run id, output, exit |
| `logs --tail` | Follows `daemon-stderr.log` (and `daemon-stdout.log` when one exists) with `tail -f` |
| `stats [flags]` | Run statistics: failure rates, durations, failures with their stderr, the output of one run |

`tools daemon stats` reads the per-task run logs inside a time window. The window is the last 24 hours unless
`--since` or `--until` says otherwise. It reads only the run logs whose names fall inside the window, and from each
only the first (meta) and last (exit) record, so a long window stays cheap. The only output it reads is the stderr of
the newest failures, at most the last 64 KB of each.

In a terminal with no `--view`, `--run` or `--json`, it opens a menu. After each view, the menu comes back with the
same window and task, until you choose Done. A bare `--view` (no value) opens the menu in a terminal too; outside a
terminal, or with `--json`, it lists the views and exits 1. In every other case it prints once and exits, for
scripts: the view you named, else `run` when you gave `--run`, `task` when you gave `--task`, else `overview`.

| Flag | Meaning |
|---|---|
| `--view [view]` | `overview`, `task`, `durations`, `failures` or `run` |
| `-t, --task <name>` | Only this task (a configured name, or a task folder that has run logs) |
| `--since <when>` | Window start (default `24h`) |
| `--until <when>` | Window end (default now) |
| `--run <runId>` | The run to print with `--view run` |
| `--json` | Print the stats as JSON |

```bash
# Every task: runs, OK, failed, timed out, killed, still open, failure rate, P50, P90, max, last run,
# and the daemon's own health lines
tools daemon stats --view overview

# One task: counts, a duration histogram, runs per hour (or per day past 48 hours), the last failure
tools daemon stats --view task --task ai-usage-poll

# Duration percentiles (P50, P90, P99, max) and histograms for every task over a week
tools daemon stats --view durations --since 7d

# Failures, newest first, each with its last 12 stderr lines (up to 20 per task)
tools daemon stats --view failures --since 2026-10-12 --until 18:00

# The full output of one run (run ids are in the RUN column of --view failures,
# in the --json output and in what `tools daemon run` prints; the menu lists runs to pick from)
tools daemon stats --view run --run 1a2b3c4d

# The same data as JSON (the shape is `DaemonStats` in lib/stats.ts, version 1)
tools daemon stats --json --since 24h
```

`--since` and `--until` take a duration back from now (`1h`, `24h`, `7d`, `90m`), a date or ISO time, or `HH:MM`
today. `--since all` reads every run log, and `--until now` is the default. A bare date as `--until` means the end of
that day. The window must not be empty: `--since` must be earlier than `--until`.

The health part of the overview counts three kinds of lines the daemon writes to the day logs
(`~/.genesis-tools/logs/<date>.log`): "scheduler wedged", "watchdog sampled late" and "task timed out". It reads at
most the last 7 day logs of the window with `rg`, also the days the daily pass compressed to `.zst`. The lines of a
finished day are kept in `~/.genesis-tools/logs/.digests/`, so a warm run searches only today's log. Measured on
2026-11-01 with five of seven days compressed: `--since 7d` took 1408 ms against 660 ms plain while it searched every
day. With the digest a warm run took 724 ms (730 ms with seven plain days), and the first run after the search
changes took 1669 ms.

### The menu

`tools daemon` with no arguments opens a menu with Status, Tasks (list, add, enable or disable, delete), Logs, Start
(foreground), Stop (one SIGTERM) and Launchd (install, uninstall, or "Migrate to GenesisTools.app" for an old job).
`stats`, `run`, `restart` and `config set` are not in it.

## How it works

### Files

| Path | What |
|---|---|
| `~/.genesis-tools/daemon/config.json` | The tasks |
| `~/.genesis-tools/daemon/daemon.pid` | The running daemon's PID and command line |
| `~/.genesis-tools/daemon/logs/<task>/` | One JSONL run log per run |
| `~/.genesis-tools/daemon/logs/daemon-stderr.log` | The launchd job's stdout and stderr (launchd writes both here) |
| `~/.genesis-tools/daemon/logs/daemon-stdout.log` | Only from an older plist; `logs --tail` follows it too |
| `~/.genesis-tools/logs/<date>.log` | The day log: the daemon's structured log lines, among every tool's |
| `~/Library/LaunchAgents/com.genesis-tools.daemon.plist` | The launchd job (label `com.genesis-tools.daemon`) |

A run log is named `<local start time>-<run id>.jsonl`, for example `2026-05-15T19-02-16-a8a9c339.jsonl`. It holds a
`meta` record (task, command, run id, attempt, start, timeout, reason, priority), one `stdout` or `stderr` record per
output line, and an `exit` record (code, duration, `timedOut`). The reason is `scheduled`, `catch-up`, `retry` or
`manual`. Task output goes to these files while the task runs, so you can debug a flaky job without restarting the
daemon.

### The launchd job

The plist runs `bun run <checkout>/src/daemon/daemon.ts`, where `<checkout>` is the checkout whose code ran
`install`, not the current directory. `tools daemon install` uses the checkout that `tools` on your PATH runs.
`./tools daemon install` in a worktree points launchd at that worktree, and launchd keeps that path after the
worktree is gone. Run `install` from the checkout you keep. When GenesisTools.app is installed, the job starts
through the app's launcher, so tasks use the app's privacy grants (Calendar, Full Disk Access and the like). A plist
written before the app existed makes `status` warn "runs outside GenesisTools.app"; `restart` (or `install`) moves it.

The job has `RunAtLoad`, `KeepAlive` (launchd restarts the daemon after any exit, at most every 10 s),
`ProcessType` `Standard`, the working directory `$HOME` and the PATH
`/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` plus bun's folder. The job was `Background` before, and then every
task inherited background QoS: a 0.2 s dry run once took 125.6 s at load average 35 (2026-10-12).

`install`, `uninstall`, `restart` and the launchd part of `status` use `launchctl`, so they work on macOS only.

When the daemon starts, it also checks that the hub widget is running (after a reboot nothing else brings it back),
and it starts the meetings watcher when you turned that on.

### Scheduling

A schedule is one of two forms, case-insensitive:

- `every <N> second|minute|hour|day|week` (plural allowed): for example `every 10 minutes`, `every 1 hour`.
- `every day at HH:MM`: a time of day, local time, 24 hours.

The daemon's loop runs a tick at least once a minute and at most once a second, and reads `config.json` on every
tick. A change to a task's command, timeout, retries, priority, notifications or enabled state applies from its next
run, without a restart.

- When the daemon starts, a task with run logs is planned from its last run (see below), and a task with no run log
  runs within 2 s (a short delay per name, so tasks do not all start at once).
- A task that the running daemon sees for the first time runs within 2 s, with or without run logs: a new task, or
  one that was removed and added again (for example by a tool's disable and then enable).
- Both rules include a daily task; after that first run it keeps its time of day.
- A disabled task keeps its planned time. After `config enable`, a task whose time passed while it was off runs at
  the next tick; a daily task whose time passed more than 10 minutes ago follows its missed-run rule.
- An interval task runs next at its planned time plus the interval. When that time has already passed (a long run,
  a sleep), it runs at once. A task never runs twice at the same time.
- A new `--every` applies after the run that is already planned. `tools daemon restart` plans every task again from
  its last run.
- After a restart, a task runs next at its last run's start plus its interval, or at once when that time is past. A
  daily task whose time passed while the daemon was down follows its missed-run rule once, however many days passed.
- Tasks due in the same tick start in priority order: `high`, then `normal`, then `low`.

### Running a task

Each run is `sh -c "<command>"` with stdin closed, in its own process group. The PATH starts with the checkout's root,
so `tools <name>` in a command is that checkout's `tools`, then the daemon's PATH, then `/usr/sbin` and `/sbin`.

- **Timeout**: 10 minutes unless `timeoutMs` says otherwise. At the timeout the daemon sends SIGTERM to the whole
  process group, and SIGKILL 3 s later. A task that cleans up on SIGTERM has 2 s for it. The grace was 500 ms, and 123
  of 300 timed-out usage polls ended in SIGKILL (2026-10-05 to 10-12).
- **Retries**: after a failed or timed-out attempt the daemon waits 2 s, 4 s, 8 s and so on (at most 60 s) and tries
  again, `retries` times. Each attempt has its own run log.
- **Notifications**: with `notify` on (the default) you get a banner when a run starts, when it completes and when it
  fails. `failure` shows only failures, `off` shows none. A task that keeps failing gets one banner, then a reminder
  every 6 hours while it still fails: before that, one task put up 38 identical banners in a day (2026-10-05). The
  count lives in memory, so a daemon restart starts a new streak. The channels come from `tools notify` for the app
  `daemon`.
- **Retention**: after each run the daemon deletes the task's run logs that are both older than `maxAgeDays` and not
  among the newest `minRuns`. It never deletes when the task has `minRuns` logs or fewer. A task without `retention`
  keeps every log. The delete does not hold the scheduler: when it did, it held it for 51 s and 80 s for five files
  (2026-10-10).

### Priority

| Priority | How the command runs |
|---|---|
| `low` | Under `taskpolicy -b`: background QoS, throttled CPU and disk. Starts last |
| `normal` | The daemon's own QoS (the default) |
| `high` | Clears any inherited background state before the command starts, so it is never throttled. Starts first |

`low` needs `/usr/sbin/taskpolicy` and `high` needs `/usr/bin/perl`; without them the task runs as `normal`. An
`on-wake` catch-up always runs at `low`.

### Missed runs (daily tasks)

A run of a time-of-day task is missed when it starts more than 10 minutes after its time: the Mac was asleep, or the
daemon was not running. Under load the daemon's timers fired 15 to 80 s late (2026-10-10), so 10 minutes means it was
really down. `missedRun` decides what happens:

| Mode | What a missed run does |
|---|---|
| `asap` | Runs at the next tick, even in a DarkWake (the default) |
| `on-wake` | Waits for a full wake (display on, not a DarkWake), checks every minute, then runs at `low` priority |
| `retry-at` | Runs at the first of its `times` still ahead that day, or at once when none is left |
| `skip` | Waits for the next regular time |

With `retry-at`, a failed run (also an on-time one) tries again at the next time still ahead that day. `on-wake`
reads the graphics bit of the power state with `ioreg`; when that read fails, it counts as a full wake, so a broken
check never holds a run back.

### Staying alive

- **One daemon only.** The pidfile records the daemon's command line, so a PID the system gave to another program is
  not taken for a live daemon. On 2026-08-19 a stale pidfile pointed at a reused PID, and launchd restarted the daemon
  4284 times in about 12 hours. A second daemon exits with code 1; one that loses a race for a stale pidfile exits 2.
- **Ownership check.** On every tick the daemon checks that the pidfile still names it, and exits 87 when not.
- **Watchdog.** When the loop has not ticked for 5 minutes of running time, the daemon exits 86 and launchd starts a
  fresh one. Time the Mac slept does not count: it once killed healthy daemons in the first seconds after a wake
  (2026-10-06, 2026-10-11).
- **Shutdown.** The first SIGTERM or SIGINT stops the loop and waits for running tasks. When the loop has not ended
  20 s later, the daemon exits anyway. A second signal exits at once.

### Tasks other tools add

Other tools add tasks from code with `registerTask()` (`lib/register.ts`). By default, a task added that way keeps
every run log younger than 14 days, and always the newest 50. A tool can pass its own retention: `ai-usage-poll`
keeps 3 days and 100 runs (`tools ai usage daemon register --retention-days`, `--retention-min`), and
`du-index-refresh` keeps 14 days and 14 runs. A tool that registers its task again over the old one writes every
field again, `enabled` too, except `priority` and `missedRun`: those are yours, and it keeps them. Some examples:

| Command | Task |
|---|---|
| `tools ai usage daemon register` | `ai-usage-poll` |
| `tools wakeup daemon register` | `wakeup-server`, every minute |
| `tools hub memos install` | `hub-memo-scan`, every 10 minutes |
| `tools hub brief schedule` | a daily task that builds the brief |
| `tools shops daemon enable` | `shops:watchlist-check`, `shops:prune-http-requests` |
| `tools git fsmonitor enable` | `git-fsmonitor-record`, every 10 minutes |

`tools du`, `tools macos` (the clone scan at 03:00 and the cache prune at 04:00), `tools services` and
`tools question` add tasks too. `tools daemon config list` shows what is on your Mac.

Nothing in the daemon itself costs money. A task's command may.

## Configuration

`~/.genesis-tools/daemon/config.json` holds the tasks. Prefer `tools daemon config set`; it validates the change and
writes the file atomically. A hand edit takes effect on the next tick. A task with an invalid name (empty, or with
`/`, `\` or `..`) or a schedule the daemon cannot read is skipped, with a warning in the day log.

```json
{
  "tasks": [
    {
      "name": "daily-digest",
      "command": "tools automate preset run daily-digest",
      "every": "every day at 09:00",
      "retries": 1,
      "enabled": true,
      "description": "Morning digest",
      "timeoutMs": 300000,
      "notify": "failure",
      "priority": "low",
      "missedRun": { "mode": "retry-at", "times": ["10:00", "12:00"] },
      "retention": { "maxAgeDays": 14, "minRuns": 50 }
    }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `name` | required | The task's name and its log folder |
| `command` | required | A shell command, run with `sh -c` |
| `every` | required | The schedule (see Scheduling) |
| `retries` | required | Extra attempts after a failed run |
| `enabled` | required | `false` keeps the task without running it |
| `description` | none | A one-line description |
| `timeoutMs` | `600000` | Kill a run after this many ms |
| `notify` | `true` | `true`, `false` or `"failure"` |
| `priority` | `"normal"` | `"high"`, `"normal"` or `"low"` |
| `missedRun` | `{"mode":"asap"}` | Daily tasks only; `times` for `retry-at` |
| `retention` | none (keep all) | `maxAgeDays` and `minRuns` |

`config add` and `registerTask()` set `retries` to 3 and `retention` to 14 days and 50 runs unless told otherwise.

Environment variables:

- `GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` folder, the daemon's files with it.
- `GENESIS_TOOLS_DAEMON_DIR` moves only the pidfile and the run logs. `config.json` and `daemon-stderr.log` stay in
  `~/.genesis-tools/daemon/`.
- `GENESIS_TOOLS_DAEMON_WAKEFUL_TICK_MS` is for tests: how often an idle daemon checks for a stop signal.

The launchd job gets only `HOME` and `PATH`. These variables set in your shell change only where the CLI (`status`,
`stats`, `run`, `logs`) reads, not where the launchd daemon writes.

## For agents

- `status --json`: `{ daemon: { installed, running, pid, needsMigration, foregroundPid }, configPath, logsBaseDir,
  tasks }`.
- `config list --json`: `{ configPath, tasks }`. Each task is its stored fields plus the effective `timeoutMs`,
  `notify`, `priority` and `missedRun`, and `schedule` in words (`every 10m`, `daily at 03:00`).
- `config set <name> ... --json`: the updated task. An unknown task, or a value that fails validation (the schedule,
  the timeout, the retries, the retry-at times), prints `{ "error": "..." }` and exits 1. A bad choice for
  `--enabled`, `--notify`, `--priority` or `--missed-run`, or no setting at all, prints a text error with no JSON on
  stdout and exits 1. A wrong value writes nothing.
- `run <name> --json`: `{ task, ok, exitCode, duration_ms, logFile, runId }`. `exitCode` is null when the run timed
  out. The process exits 0 when the task exited 0, else 1.
- `stats --json`: `DaemonStats` version 1 (`lib/stats.ts`). Times are ISO UTC, durations are ms. A run's status is
  `ok`, `failed`, `timedOut`, `killed` (no exit code and no timeout) or `unfinished` (no exit record). The
  GenesisTools settings window reads it, so fields are only added; `version` goes up when a meaning changes.
- `stats --view run --run <id> --json`: `{ run, lines }`, every stdout and stderr line of that run.
- Exit 1 also comes from a bad flag value, an unknown task in `run` or `config set`, and an empty or unreadable
  stats window. `config enable`, `config disable` and `config remove` with an unknown name print a message and exit 0.
- `install`, `restart`, `stop` and `start` report their failures as a message and exit 0: a failed `launchctl` load,
  a job that is not installed, a daemon that survives SIGKILL, a daemon that already runs. Check the result with
  `tools daemon status --json`.
- `config add` needs a terminal. An agent adds a task with `registerTask()` in code, or with a hand edit of
  `config.json`.
- The GenesisTools settings window (Background, then Daemon) reads `status --json` and `stats --json`, saves with
  `config set ... --json`, and runs a task with `run --json`. It never writes `config.json` itself.

## Troubleshooting

**Tasks run very slowly, or a dry run takes minutes.** The plist predates `ProcessType` `Standard`, so every task
inherits background QoS. Run `tools daemon install` again. For one task, `tools daemon config set <name> --priority
high` lifts it even under an old plist.

**`status` says the daemon runs outside GenesisTools.app.** The plist was written before the app existed, so tasks
do not get the app's privacy grants. Run `tools daemon restart`.

**`tools daemon stop` and the daemon is back.** launchd's `KeepAlive` restarts it; `stop` reports "bounced". Use
`tools daemon stop --uninstall` or `tools daemon uninstall` to stop it for good. When `stop` says the daemon is not
running, `--uninstall` does nothing, so use `tools daemon uninstall`.

**`tools daemon start` says the daemon already runs via launchd.** Two schedulers would run each task twice. Use the
launchd daemon, or run `tools daemon uninstall` first.

**`restart` says the daemon is not installed via launchd.** `restart` works on the launchd job only. Run
`tools daemon install`, or stop the foreground daemon with Ctrl+C and start it again.

**A task is missing after a hand edit of `config.json`.** Its name or schedule is invalid. Search today's day log for
`[daemon] invalid task`.

**A new daily task ran right after you added it.** A task that the running daemon sees for the first time runs once
right away, with or without run logs, then keeps its time. At daemon start, only a task with no run log does that.

**A changed schedule still runs at the old time.** The run that was already planned keeps its time. Run
`tools daemon restart` to plan again now.

**A daily task ran in the middle of the night, after the Mac slept through its time.** That is its missed-run rule:
`asap` runs in a DarkWake. Set `--missed-run on-wake`, `retry-at` or `skip`.

**Too many banners.** `tools daemon config set <name> --notify failure`, or `off`.

**A task times out.** Read its last stderr lines with `tools daemon stats --view failures --task <name>`, then raise
`--timeout-ms` or fix the command.

**The overview's health part says "rg is not on PATH".** It needs ripgrep to scan the day logs. Install `rg`; the
task numbers do not need it.

**The daemon keeps exiting.** Read `~/.genesis-tools/daemon/logs/daemon-stderr.log` (`tools daemon logs --tail`) and
the day log. Exit 1 means another daemon already runs, a second stop signal, a loop that had not stopped 20 s after
the first signal, or a crash at start (for example a config read that timed out); the day log says which. 2 means it
lost a race for a stale pidfile, 86 means the watchdog found the loop wedged, and 87 means another process took the
pidfile.

## Related

- [`tools automate`](../automate/README.md) has its own scheduler (`tools automate daemon`, a separate launchd job)
  for its presets. A daemon task can run `tools automate preset run <name>` too.
- [`tools ai`](../ai/README.md), [`tools hub`](../hub/README.md), [`tools wakeup`](../wakeup/README.md),
  [`tools shops`](../shops/README.md), [`tools git`](../git/README.md), [`tools du`](../du/README.md),
  [`tools macos`](../macos/README.md), [`tools services`](../services/README.md) and
  [`tools question`](../question/README.md) add tasks here.
- [`tools notify`](../notify/README.md) sets where the daemon's banners go.
- [`tools dev-dashboard`](../dev-dashboard/README.md) has a Daemon page with the tasks and recent runs.
- [`tools compress`](../compress/README.md) compresses the day logs the overview's health part reads.
