# tools macos-resources

A live terminal dashboard of the processes on your Mac, with CPU %, memory and open-file counts in a sortable table.
Use it to watch a leak or a runaway process, and to get an alert (in the dashboard, as a desktop banner, or spoken)
when a process goes over a CPU, memory or open-files limit.

## Quick start

```bash
# Every process, sorted by CPU
tools macos-resources

# Only processes whose name or command line contains "chrome", with a desktop banner above 50% CPU
tools macos-resources --process chrome --cpulimit 50 --notify

# One process, by pid
tools macos-resources --process 4242

# Alert when any process goes over 80% CPU or 1000 MB of memory
tools macos-resources --cpulimit 80 --memorylimit 1000

# Speak an alert when a process holds more than 100 open files, and refresh every 2 seconds
tools macos-resources --fileslimit 100 --say --interval 2
```

## Options

The tool has no subcommands and takes no positional arguments: `tools macos-resources chrome` is an error, so use
`-p chrome`.

| Option | Short | What it does |
|---|---|---|
| `--process <name or pid>` | `-p` | Show only matching processes |
| `--cpulimit <percent>` | `-c` | Alert when a process uses more CPU than this |
| `--memorylimit <MB>` | `-m` | Alert when a process uses more memory than this |
| `--fileslimit <count>` | `-f` | Alert when a process has more open files than this |
| `--interval <seconds>` | `-i` | Seconds between refreshes, default 5 |
| `--notify` | `-n` | Post a desktop notification for each alert |
| `--say` | `-s` | Speak each alert aloud |
| `--help` | `-h` | Print the help and exit |

- A numeric `--process` is an exact pid. Any other text matches a process when its name or its full command line
  contains the text, ignoring case.
- A limit must be a number of 0 or more, and `--fileslimit` must be a whole number. Anything else stops the tool
  with `Invalid value for --cpulimit: abc` and exit code 1. An alert fires when a value is above the limit, not
  equal to it.
- `--interval` accepts fractions (`2.5`). A zero, negative or non-numeric value falls back to 5 seconds without a
  warning.
- Without `--notify` or `--say`, an alert shows only in the dashboard's Notifications panel.
- `--notify` and `--say` act only on alerts, and an alert needs at least one of `--cpulimit`, `--memorylimit` or
  `--fileslimit`.
- `cpu` and `--cpulimit` use ps `pcpu`, a decaying average in percent of one core: a process on four cores can show
  400%, and a short spike shows late. For an exact reading of the last few seconds, use `tools doctor cpu`
  ([doctor](../doctor/README.md)).

## Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection |
| `f` | Show or hide the open files of the selected process |
| `Esc` | Close the open-files view |
| `r` | Refresh now, and re-read the open-file count of every process |
| `s` | Change the sort: CPU, then Files, then PID, then CPU again |
| `q` | Quit |

Ctrl+C does not quit. The tool turns off the Ctrl+C exit of its terminal UI library (Ink) and quits only on `q`.

## The screen

Three panels sit side by side.

- **The process table** (left). The header line shows the process count and the update time. The next line shows
  the filter, the limits and the sort. The table has these columns: `pid` (`>` marks the selection), `process` (the
  first 20 characters of the name), `cpu`, `memory` (resident memory in MB), `files` (`?` while the count is not
  known) and `command` (the first 120 characters, on two lines). The sorted column has a `↓` in its header. CPU
  and Files sort from high to low; PID sorts from low to high.
- **Notifications** (middle). The last 50 messages, newest first: alerts, sort changes, `Refresh triggered`, and
  any failed refresh.
- **Commands Performance** (right). The last 10 child commands that the refreshes ran, with their time in ms, for
  example `ps -axo (812 rows) - 45ms` and `lsof -p ×60 (1 batch) - 120ms`. While the `f` view is open, its in-process read also appears, as
  `open files 4242 - 3ms`.

The table shows only the rows that fit the terminal, with a `rows X-Y of N` line above it, and scrolls to keep the
selection in view. The row count is the terminal height minus 15, divided by 3, and never less than 5.

## Alerts

- **CPU.** A process alerts once, then stays quiet for 30 seconds. There is also a 60-second pause across all
  processes, so you get at most one CPU alert a minute.
- **Memory and open files.** A process alerts once when it goes over the limit, and again only after it drops back
  under the limit and goes over again. A process whose open-file count is `?` never raises a files alert.
- The banner titles are `High CPU Usage`, `High Memory Usage` and `High File Usage`. The message reads like
  `node uses 92.0% CPU`.
- `--notify` posts through GenesisTools.app when the app can take it, then terminal-notifier, then `osascript`.
  The `osascript` route cannot confirm that macOS showed the banner. Every banner is also written to
  `~/.genesis-tools/notifications/ledger.jsonl`.
- `--say` speaks the message with the local macOS voice and its default settings.
- Neither option goes through `tools notify` or `tools say`. The channels of `tools notify` (Telegram, webhook,
  phone) and the profiles and mute of `tools say` do not apply to these alerts.

## How it works

- **One refresh per `--interval`.** Each refresh runs one `ps -axo pid=,pcpu=,rss=,command=` for every process on
  the Mac and draws the table at once. Then it counts open files with `lsof -n -P -w -Fpf -p a,b,c,...`, 60 pids
  per call. Nothing runs through a shell, and each `ps` or `lsof` call is killed after 10 seconds.
- **Which counts it reads.** A process gets a new open-file count when it was never asked, when it is the selected
  row, or when its count is older than 60 seconds. `r` re-reads all of them. In steady state a refresh is two child
  processes (one `ps`, one `lsof` for the selected row), however many rows there are. About once a minute every count
  ages out at the same time, and that refresh re-reads
  all of them: one `ps` plus one `lsof` per 60 pids. The first refresh reads every
  process and takes some seconds, but the table appears before it finishes.
- **Why a count stays `?`.** `lsof` cannot read processes of other users without root, and pids 100 and below
  (plus names that contain `kernel`) are never asked. A process that refused is asked again once a minute, not on
  every refresh. When the code asked again every refresh, it measured 430 pids and 9 child processes per refresh
  where 1 pid and 2 child processes were intended.
- **The open-files view (`f`)** reads the selected process directly from the kernel, with no `lsof` call. It lists
  the working directory (`cwd`), the executable (`txt`) and every open descriptor, all sorted by type and then by name. It shows
  the first 30 entries (paths cut to 50 characters) with a `... and N more files` line, and it reads again on each
  refresh while it is open. A process of another user shows an empty list. The `files` column counts `lsof` rows
  and this list leaves out the memory-mapped rows of `lsof`, so the two numbers can differ.
- **Only the visible rows are drawn.** Each process row takes three terminal lines. When the rewritten table drew
  all of about 2100 processes, it measured 70% of a core and 3.2 GB of heap, where the version before the rewrite
  used 4% and 149 MB for the same data. Drawing only the rows that fit removed that cost, and the numbers below
  were measured with it.
- **Measured on the rewrite (PR #404).** One `ps` and one `lsof` per process per refresh came to at least 10470
  child processes a minute (a sampled floor) and 4.5% CPU. The batched refresh came to at least 120 a minute and 2.5%
  CPU. Memory went up from 145
  to 192 MB, and that cost was accepted. The numbers and the scripts are in
  [docs/benchmarks-cpu.md](../../docs/benchmarks-cpu.md).

The tool keeps no config and no data of its own. It needs an interactive terminal and the `ps` and `lsof` that
macOS ships (it finds `lsof` in `/usr/sbin` when `PATH` does not have it). `--notify` needs notification permission
for GenesisTools.app or terminal-notifier. Nothing calls the network or costs money.

Logs go to the day log `~/.genesis-tools/logs/<date>.log`: a failed refresh, a failed banner or voice alert, and
a failed open-files listing. A failed run, such as a bad option value, is also written to
`~/.genesis-tools/logs/<date>-failures.jsonl`; read it with `tools genesis-tools logs failures`.

## For agents

- This is an interactive view only. There is no `--json` and no one-shot mode. Without a terminal on stdin it
  prints one line to stderr and exits 1:

  ```text
  this view needs an interactive terminal; for a one-shot check of what is using CPU now, run tools doctor cpu
  ```

  Use `tools doctor cpu` for a scriptable answer.
- Exit codes: 0 for `--help`; 1 for a bad option value, an unknown option, an extra argument, or no terminal.
- There is no MCP tool and no plugin skill for it.
- The refresh logic lives in [lib/process-data.ts](lib/process-data.ts), with no React and no side effects at import
  (`runRefreshCycle`, `listProcesses`, `planOpenFilesRefresh`). Two benchmarks drive it:

```bash
# Exact child processes per refresh; the steady-state number should be 2
bun scripts/benchmarks/macos-resources/count-spawns.ts --cycles 5

# CPU, memory and a floor of child processes per minute for the live dashboard
bun scripts/benchmarks/macos-resources/spawn-storm.ts --seconds 20 --runs 3
```

## Troubleshooting

- **`this view needs an interactive terminal`.** stdin is not a terminal (an agent, CI, a pipe). Run it in a real
  terminal, or use `tools doctor cpu`.
- **Many rows show `?` in `files`.** Those processes belong to another user or are system pids, or the first
  refresh is still running. `r` asks again, but `lsof` still refuses other users' processes.
- **Ctrl+C does nothing.** Press `q`.
- **`--notify` shows no banner.** First check that a limit flag is set: with no `--cpulimit`, `--memorylimit` or
  `--fileslimit` there is never an alert. Otherwise the route may have fallen back to
  `osascript`, which cannot confirm delivery.
  Run `tools notify authorize` to ask macOS for permission.
- **`--say` ignores your `tools say` voice or mute.** This is by design: it speaks with the local macOS voice
  directly, not through `tools say`.
- **The table shows only a few rows.** The terminal is short. Make the window taller; the minimum is 5 rows.

## Related

- [tools doctor](../doctor/README.md): `tools doctor cpu` samples CPU time twice and lists what used it, in one shot.
- [tools notify](../notify/README.md): desktop banners, notification permission and other channels.
- [tools say](../say/README.md): speech with saved per-app profiles.
