# tools fsevents

> **Inspect macOS file system events: which directories churn the most, and which processes watch the FSEvents device.**

macOS only. It uses the native `fsevents` package, which reads the same event stream Spotlight, Time Machine and every file watcher read.

## Commands

| Command | Description |
|---------|-------------|
| `profile [path]` | Watch a directory for a few seconds and rank the directories with the most events |

## `profile`

```bash
# Watch the whole volume for the default 15 seconds
tools fsevents profile

# Watch one directory
tools fsevents profile ~/Library/Caches

# Sample for 30 seconds and list the top 5 directories
tools fsevents profile -d 30 -t 5 /tmp

# Print every event as it arrives (stderr), then the ranking
tools fsevents profile -v /tmp

# Machine-readable result
tools fsevents profile --json /tmp

# List the processes that open /dev/fsevents (needs root)
sudo tools fsevents profile --watchers
```

Options:

-   `[path]`: directory to watch (default: `/`). Symlinks are resolved, so `/tmp` is reported as `/private/tmp`.
-   `-d, --duration <seconds>`: sample length (default: 15, or 5 with `--watchers`). A fraction such as `0.5` works.
-   `-t, --top <number>`: how many directories to list (default: 10).
-   `-w, --watchers`: list the processes that open the FSEvents device instead (needs root).
-   `--json`: print the result as JSON on stdout.
-   `-v`: print each event on stderr as it arrives.

Ctrl-C ends the sample early and still prints the ranking, then the process exits with 130.

Example output:

```
59 events in 4 directories under /private/tmp/demo (5.0 s).

Top 4 most active:
EVENTS  SHARE  DIRECTORY
──────  ─────  ──────────────────────
    40  67.8%  /private/tmp/demo/hot
    12  20.3%  /private/tmp/demo/warm
     4   6.8%  /private/tmp/demo/cold
     3   5.1%  /private/tmp/demo
```

An event counts toward the parent directory of the item that changed. The example comes from a run where one process wrote 40, 12 and 3 files into three folders, then deleted one.

## How it works

1. `lib/sample.ts` starts a native FSEvents watcher on the resolved path and sleeps on one timer, so the process is idle between events. The timer and Ctrl-C both end the wait.
2. `lib/churn.ts` keeps one counter per directory. Memory grows with the directories touched, not with the events seen, so a long sample of `/` stays small.
3. `lib/format.ts` turns the ranking into text. Paths are never shortened, so you can copy one straight into the next command.
4. `lib/watchers.ts` backs `--watchers`. It reads `fs_usage -w` as the output arrives, keeps the lines that name `/dev/fsevents`, and ends `fs_usage` itself at the deadline.

## Notes

-   Watching `/` can produce a very large number of events. Pass a path to narrow it.
-   FSEvents merges the events of one item inside a short window, so the counts rank directories against each other. They are not an exact tally of system calls.
-   `--watchers` shows a process only when it opens the device inside the sample window. `fs_usage` ends each line with the process name and a **thread** id, so the report counts distinct thread ids and does not name a pid.
-   `tools fsevents profile` replaces the old `tools fsevents-profile`.
-   The type declaration in `fsevents.d.ts` exists because the package is macOS-only: bun does not install it on Linux, where the typecheck would otherwise stop at the missing module.
