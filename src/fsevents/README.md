# tools fsevents

Find out what keeps the macOS file system event stream busy: `tools fsevents profile` ranks the directories with the
most events, or lists the processes that open the FSEvents device. Use it when `fseventsd` runs hot, Spotlight or a
file watcher keeps waking up, or a sync folder never settles.

macOS only. It reads the same event stream that Spotlight, Time Machine and every file watcher read.

## Quick start

```bash
# Rank the busiest directories on the whole volume for the default 15 seconds
tools fsevents profile

# Watch one project for 30 seconds and list the top 5 directories
tools fsevents profile -d 30 -t 5 ~/Projects/app

# Print every event on stderr as it arrives, then the ranking
tools fsevents profile -v ~/Projects/app

# The ranking as JSON on stdout
tools fsevents profile --json /tmp

# List the processes that open /dev/fsevents (needs root)
sudo tools fsevents profile --watchers
```

## Commands

`tools fsevents` has one command, `profile`, with two modes. Run without arguments, the tool prints its help.

| Command | What it does |
|---|---|
| `profile [path]` | Sample events under `path` and rank the directories with the most events |
| `profile --watchers` | Sample `fs_usage` and list the processes that open `/dev/fsevents` (root) |

### `profile` flags

| Argument or flag | Default | Meaning |
|---|---|---|
| `[path]` | `/` | Directory to watch |
| `-d, --duration <seconds>` | 15, or 5 with `-w` | Sample length. A fraction such as `0.5` works |
| `-t, --top <number>` | 10 | How many directories to list. A whole number |
| `-w, --watchers` | off | List the processes that open the FSEvents device instead |
| `--json` | off | Print the result as JSON on stdout |

Global flags: `-v, --verbose` prints each event on stderr as it arrives, plus the tool's debug log lines. It works
before or after `profile`. `--readme` prints this page.

The path:

-   A relative path is resolved from the current directory.
-   Symlinks are resolved, because FSEvents reports real paths. So `/tmp` is reported as `/private/tmp`.
-   It must exist and be a directory. A file is refused.
-   With `--watchers`, `[path]` and `--top` are not used: `fs_usage` sees the whole system, and the report lists every
    process it saw.

Ctrl-C ends a directory sample early and still prints the ranking, then the process exits with 130. In watchers
mode, Ctrl-C stops `fs_usage` early, prints what it saw and also exits 130 (the watchers JSON has no `interrupted`
field, so the exit code is the only signal). Copies of one Ctrl-C that arrive within half a second count as one. A later,
second Ctrl-C ends the process at once.

### Directory mode (the default)

```
59 events in 4 directories under /private/tmp/demo (5.0 s).

Top 4 most active:
EVENTS  SHARE  DIRECTORY
──────  ─────  ──────────────────────
    40  67.8%  /private/tmp/demo/hot
    12  20.3%  /private/tmp/demo/warm
     4   6.8%  /private/tmp/demo/cold
     3   5.1%  /private/tmp/demo

Look for caches, build output directories and cloud sync folders in this list.
```

An event counts toward the parent directory of the item that changed. The example comes from a run where one process
wrote 40, 12 and 3 files into three folders, then deleted one. The three new folders are the 3 events of
`/private/tmp/demo` itself.

-   A share under 0.1% prints as `<0.1%`.
-   Paths are never shortened, so you can copy one straight into the next command.
-   A sample that Ctrl-C ended says so in the first line: `(1.3 s, stopped early)`.
-   A quiet sample prints one line: `No file system events under /private/tmp/demo (5.0 s).`

With `-v`, each event prints on stderr as `<event> (<type>) <path>`, for example
`created (file) /private/tmp/demo/hot/a.txt`. The events are `created`, `cloned`, `modified`, `deleted`, `moved`,
`root-changed` and `unknown`. The types are `file`, `directory` and `symlink`. An event without an item type prints `(undefined)`.

### Watchers mode (`--watchers`)

```bash
# Sample for 30 seconds instead of 5
sudo tools fsevents profile --watchers -d 30
```

```
2 processes opened /dev/fsevents during the 5.0 s sample:
OPENS  THREADS  PROCESS
─────  ───────  ──────────
    3        2  mds_stores
    1        1  Finder
```

`OPENS` is how often the process opened the device inside the sample window. `THREADS` is the number of distinct
thread ids those opens came from. The busiest process comes first, and equal counts sort by name.

`fs_usage` ends each line with the process name and a **thread** id (`Mail.4821`), never a process id. So the report
counts distinct thread ids and does not name a pid. A process name can contain spaces (`Google Chrome H`).

A process shows only when it opens the device inside the sample window. A watcher that was already running stays
hidden, and the report says so:

```
No process opened /dev/fsevents during the 5.0 s sample.
fs_usage only sees a process while it opens the device, so a watcher that was already running stays hidden.
Run it again with a longer --duration, or restart the app you suspect.
```

### Workflow: find what keeps the event stream busy

```bash
# 1. Rank the whole volume over a longer window
tools fsevents profile -d 30

# 2. Narrow to the top directory to see which folder inside it churns
tools fsevents profile -d 30 ~/Projects/app

# 3. See the event kinds and file names in that folder
tools fsevents profile -v -d 10 ~/Projects/app/build

# 4. Name the processes that open the device; restart the suspect app during the sample
sudo tools fsevents profile --watchers -d 30
```

Caches, build output directories and cloud sync folders are the usual top entries. While `fseventsd` itself holds
1 GiB of memory or more, `tools doctor` skips its walk-heavy scans (see Related).

## How it works

-   **Storage.** The tool has no config file and stores nothing of its own. Status lines (`Watching … for 15 s`) go to
    stderr and the report goes to stdout. A thrown error (a bad flag, a bad path, `fs_usage` failing) is also written,
    with its stack, to the day log in
    `~/.genesis-tools/logs/`.
-   **Directory mode.** It starts a native FSEvents watcher on the resolved path through the `fsevents` npm package,
    then waits on one timer. The process is idle between events, and the timer or Ctrl-C ends the wait. It keeps one
    counter per directory, never one record per event, so memory grows with the directories touched, not with the
    events seen. A long sample of `/` stays small.
-   **Watchers mode.** It runs Apple's `fs_usage -w`, reads its output as it arrives, keeps the lines that name
    `/dev/fsevents`, and ends `fs_usage` itself at the deadline. The old `sh -c "fs_usage | grep"` form killed only the
    shell at the deadline and left `fs_usage` running.
-   **What it needs.** macOS. Root for `--watchers`, because `fs_usage` needs root. The root check reads the `USER`
    variable, which `sudo` sets to `root`. No network, no accounts, nothing that costs money.

The source:

| File | Role |
|---|---|
| `commands/profile.ts` | Flags, defaults, the macOS and root checks, JSON output |
| `lib/sample.ts` | Resolves the path, runs the FSEvents watcher until the deadline or Ctrl-C |
| `lib/churn.ts` | One counter per directory, ranked by count and then by path |
| `lib/format.ts` | The text reports |
| `lib/watchers.ts` | Runs `fs_usage -w` and parses its lines |
| `fsevents.d.ts` | Types for the macOS-only `fsevents` package (see Notes) |

## Configuration

There is nothing to configure. `DEBUG=1` in the environment acts like `-v`.

## For agents

`--json` prints one line of JSON on stdout. Status lines go to stderr, so stdout parses as it is. There is no MCP tool,
node-repl toolset or plugin skill for this tool. `elapsedMs` is a fractional number of milliseconds. A failure prints
no JSON: stdout is empty, the message goes to stderr, and the exit code is 1.

Directory mode (`directories` holds at most `--top` entries; `share` is a fraction from 0 to 1):

```bash
tools fsevents profile --json -d 5 /tmp/demo | jq .
```

```json
{
  "root": "/private/tmp/demo",
  "elapsedMs": 5003.418583,
  "interrupted": false,
  "total": 59,
  "distinctDirectories": 4,
  "directories": [
    { "directory": "/private/tmp/demo/hot", "count": 40, "share": 0.6779661016949152 },
    { "directory": "/private/tmp/demo/warm", "count": 12, "share": 0.2033898305084746 },
    { "directory": "/private/tmp/demo/cold", "count": 4, "share": 0.06779661016949153 },
    { "directory": "/private/tmp/demo", "count": 3, "share": 0.05084745762711865 }
  ]
}
```

Watchers mode:

```json
{
  "elapsedMs": 5004.207119,
  "watchers": [
    { "command": "mds_stores", "opens": 3, "threadIds": [4821, 4822] },
    { "command": "Finder", "opens": 1, "threadIds": [9001] }
  ]
}
```

| Exit | When |
|---|---|
| 0 | The report printed, also when it found no events or no watchers |
| 1 | Not macOS, `--watchers` without root, a bad flag value, a bad path, or `fs_usage` failed |
| 130 | Ctrl-C ended the sample early (either mode); the report still printed |

## Troubleshooting

-   **`profile needs macOS: it reads FSEvents, which other systems do not have.`** Only macOS has FSEvents. A bad
    `--duration` is still reported first on every system.
-   **`Listing the processes that open /dev/fsevents needs fs_usage, which needs root.`** Run it again through `sudo`.
    The check reads `USER`, so a root shell whose `USER` is not `root` is refused too.
-   **`Cannot watch <path>: it does not exist or cannot be read.`** or **`… it is not a directory.`** Pass an existing
    directory. To watch one file, watch its folder.
-   **`--duration must be a positive number, got "abc".`** `--duration` takes any number above 0. `--top` takes a
    whole number above 0 (`--top must be a whole number, got "2.5".`), and it is checked only in directory mode.
-   **`No file system events under …`** Nothing changed in that window. Use a longer `--duration` or a wider path.
-   **`No process opened /dev/fsevents during the … sample.`** The watcher opened the device before the sample began.
    Use a longer `--duration`, or restart the suspect app while the sample runs.
-   **`fs_usage exited with code <n>: …`** `fs_usage` failed on its own. The message ends with its stderr.
-   **The counts are lower than the writes you made.** FSEvents merges the events of one item inside a short window.
    The counts rank directories against each other. They are not an exact tally of system calls.
-   **Watching `/` produces a very large number of events.** Pass a path to narrow it.

## Notes

-   `tools fsevents profile` replaces the old `tools fsevents-profile` (moved on 2026-10-05). The old name no longer
    exists.
-   The type declaration in `fsevents.d.ts` exists because the package is macOS-only: bun does not install it on Linux,
    where the typecheck would otherwise stop at the missing module.

## Related

-   [`tools doctor`](../doctor/README.md): its scan gate skips the walk-heavy rules while `fseventsd` holds 1 GiB of
    memory or more.
-   [`tools du`](../du/README.md): clone-aware disk usage. Its scheduled index refresh is a full walk, because only a
    full walk sees the growth that FSEvents missed.
-   [`tools macos`](../macos/README.md): `tools macos eslogger -c file` streams Endpoint Security file events with the
    process behind each one (needs root and Full Disk Access).
