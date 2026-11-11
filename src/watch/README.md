# tools watch

`tools watch` prints the files that match one glob pattern, like `tail` over many files at once. With `--follow` it
keeps running like `tail -f`: it prints what is appended to each file, picks up new files that match, and reports
files that go away. Use it to follow a folder of logs, or to see the newest lines of every file in a tree.

## Quick start

It ships with GenesisTools and needs nothing else. Once the repository's `./install.sh` has put `tools` on your PATH,
run it from the folder the pattern starts in.

```bash
# Print the last 50 lines of every TypeScript file under src/, oldest first, then exit
tools watch "src/**/*.ts"

# Follow every log file under logs/: appends, new files and deletions, until Ctrl+C
tools watch "logs/**/*.log" --follow

# Several file types in one pattern, from your home folder
tools watch "~/Projects/app/**/*.{js,ts,tsx,json}"

# Show more lines of each file, and rescan for new files every 5 seconds
tools watch "logs/*.log" -f --lines 100 --seconds 5

# Keep only some output lines: the output is on stderr, so redirect it first
tools watch "logs/*.log" -f 2>&1 | grep -i error
```

Always quote the pattern. Without quotes the shell expands it before the tool sees it, and the tool refuses to run
(see Troubleshooting).

## Commands

`tools watch` has no subcommands. It takes one argument and these flags:

```
tools watch <pattern> [-f] [-n <lines>] [-s <seconds>] [-v]
```

| Flag | Default | What it does |
|---|---|---|
| `<pattern>` | required | One glob, relative to the current folder. Quote it. |
| `-f, --follow` | off | Keep running and print changes, new files and deletions. |
| `-n, --lines <n>` | `50` | Lines per file on its first view. `0` prints the whole file. |
| `-s, --seconds <n>` | `1` | Rescan interval in follow mode, in whole seconds. |
| `-v, --verbose` | off | Also print the folder, the patterns, each scan and event. |
| `--readme` | | Print this README and exit. |
| `-h, --help` | | Print the help and exit. |

A file that ends in a newline (every normal log) shows `N-1` lines of text plus an empty `│ ` row, because the tail read
counts the empty last piece as a line. Use `-n 51` to see 50 lines of text.

### The two modes

- **One-shot (default).** The tool lists the matched folders and files, prints the last `--lines` lines of each file,
  and exits 0. Files print oldest modified first, so the newest file ends at the bottom of the screen.
- **Follow (`-f`).** The tool prints the same first view, then keeps running. An append prints only the new text,
  with no line limit. A new matching file prints with a `NEW FILE` header and its last `--lines` lines. A deleted
  file prints a `REMOVED` line. Ctrl+C closes every watcher and ends the run.

### Patterns

The pattern goes to [glob](https://github.com/isaacs/node-glob) 13, run from the current folder.

- `**` matches any depth, `{a,b}` matches either word, and `[…]` matches one character from a set.
- `!(…)` excludes a name inside one path part: `"src/**/!(*.test).ts"` matches `x.ts` but not `x.test.ts`.
- `~` at the start expands to your home folder. An absolute path works too.
- Hidden files and hidden folders match (`dot` is on). Folders themselves never match, only files.
- `\` is a path separator, never an escape. To match a literal `*` or `?` in a name, use `[*]` or `[?]`.
- The tool takes **one** pattern. A second argument fails with `too many arguments`. Join patterns with braces:
  `"{src,lib,test}/**/*.js"`.
- The pattern must contain at least one of `* ? [ ] { } ( )`. To follow exactly one file, give a pattern that only
  that file matches, such as `"logs/app.lo[g]"`, or use `tail -f`.

More pattern examples:

```bash
# Nested folders by name
tools watch "src/**/components/**/*.tsx"

# Three sibling folders in one pattern
tools watch "{src,lib,test}/**/*.js"

# TypeScript files without the tests
tools watch "src/**/!(*.test).ts" -f
```

### What the output looks like

The output is plain text with colors. File contents print inside a box. The time on a file header is the file's
modification time; the time on a `REMOVED` line is the time the tool noticed it.

```
ℹ️ Watching files matching pattern: /projects/app/logs/*.log
ℹ️ Base directory: /projects/app
ℹ️ Directory rescan interval: 1 seconds
ℹ️ Lines to display: 50
ℹ️ Follow mode enabled: continuously tailing files
ℹ️ Performing initial scan for existing files...

📁 WATCHED DIRECTORIES:
   ├─ /projects/app/logs

📁 WATCHED FILES:
   ├─ /projects/app/logs/api.log
   ├─ /projects/app/logs/worker.log

📄 EXISTING FILE: 14:20:03 - /projects/app/logs/worker.log
┌──────────────────────────────────────────────────────────────────────────────┐
│ worker started
│ 
└──────────────────────────────────────────────────────────────────────────────┘

📄 EXISTING FILE: 14:23:45 - /projects/app/logs/api.log
┌──────────────────────────────────────────────────────────────────────────────┐
│ GET /health 200
│ 
└──────────────────────────────────────────────────────────────────────────────┘
ℹ️ Starting file watcher...
ℹ️ Watch-glob is running. Press Ctrl+C to stop.
ℹ️ Watcher initialized and ready

📝 UPDATED: 14:24:12 - /projects/app/logs/worker.log
┌──────────────────────────────────────────────────────────────────────────────┐
│ job 42 done
│ 
└──────────────────────────────────────────────────────────────────────────────┘

📄 NEW FILE: 14:25:01 - /projects/app/logs/cron.log
┌──────────────────────────────────────────────────────────────────────────────┐
│ cron tick
│ 
└──────────────────────────────────────────────────────────────────────────────┘

🗑️  REMOVED: 14:26:30 - /projects/app/logs/cron.log
```

- The first view marks every file `EXISTING FILE`. Later files are `NEW FILE`. A file that is empty at the first view
  prints nothing then, and its first write shows as `NEW FILE`.
- `UPDATED` appears only when a different file changes than the one printed last. More appends to the same file
  print only their boxes.
- Paths are absolute. A box prints only when the new text is not blank.
- One-shot mode ends with `Finished displaying files. Exiting.` instead of the follow lines.

## How it works

**The first view.** The tool expands `~`, runs the glob, records the modification time of each match, prints the
folder and file lists, and prints each file. For a file's first view it reads backwards from the end in 1 KB chunks
until it has `--lines` lines, so a large file is not read whole.

**Follow mode** uses three layers, so an event the platform drops is still caught:

1. One `fs.watch` per matched file prints an append at once.
2. chokidar 5 watches the matched files and their parent folders with native events (FSEvents on macOS, no polling).
   It reports changes, new files and deletions. It waits until a file's size has been stable for 50 ms.
3. Every `--seconds`, a rescan runs. It stats each file once: a file that grew without an event prints its new text,
   and a file that shrank (truncated or rewritten in place) restarts from byte 0 and prints again from the start. Then
   it runs the glob again to find new and deleted files.

A new file next to a file that already matched is reported by its folder's event and prints at once. A file in
another folder is found by the rescan and prints at its next write or at the next rescan, so up to two `--seconds`
intervals later.

Each watcher is created once and never rebuilt. On bun 1.3.13 on macOS, an `fs.watch` created after any `FSWatcher.close()` in
the same process delivers at most one event and then goes deaf, so rebuilding watchers on each rescan killed the instant path. That is
also why the rescan stays as the backstop. On that bun version, after a matched file is deleted, appends to files
found later can print up to one `--seconds` late.

**Measured, 2026-09-16.** The tool used to run a 50 ms stat loop, chokidar polling and per-file watchers rebuilt on
every rescan, all at once: 1.6% CPU while idle. Native events, watchers added once and one size sweep per `--seconds`
brought that to 0.8%, and a new file shows up 37% sooner. The numbers and the harness are in
[docs/benchmarks-cpu.md](../../docs/benchmarks-cpu.md); rerun them with
`bun scripts/benchmarks/fs/tools-watch.ts --compare`.

**Data and configuration.** The tool keeps no config file, cache or state of its own, and reads no environment
variable of its own. It calls no network service and no other tool. It uses only `node:fs`, chokidar and glob, so
it needs no macOS permission of its own. It was written to run on macOS, Linux and Windows.

**The day log keeps a copy.** The tool prints through the shared GenesisTools logger, and that logger also writes
every line to the day log, `~/.genesis-tools/logs/<date>.log`. File contents land there too. Do not follow a file
that holds secrets, and expect the day log to grow while you follow a busy log. Read that copy with
`tools genesis-tools logs day --tool watch --level info`.

## For agents

- There is no `--json`, no MCP tool and no plugin skill. The output is human text on **stderr**; capture it with
  `2>&1`.
- One-shot mode is a safe read: it prints and exits. Follow mode never exits by itself. Run it in the background or
  under `timeout`, and read its output, not its exit code.
- Exit codes: `0` after a one-shot view. `1` when no file matches, when the pattern looks shell-expanded, or when
  the argument list is wrong (a missing or second pattern). `130` after Ctrl+C (SIGINT) in follow mode.

## Troubleshooting

- **`Error: It appears your glob patterns may have been expanded by the shell`.** The pattern has no glob character.
  Either the shell expanded an unquoted glob into one path, or you passed a plain path. Quote the glob. For one file,
  see the `[g]` trick under Patterns.
- **`error: too many arguments. Expected 1 argument but got N`.** The shell expanded an unquoted glob into several
  paths, or you passed two patterns. Quote the glob, and join patterns with `{a,b}`.
- **zsh prints `no matches found` and the tool never starts.** An unquoted glob matched nothing in zsh. Quote it.
- **`No files found matching the patterns. Exiting.`** The pattern is relative to the current folder, so check
  where you run it. On macOS, a terminal without access to `~/Documents`, `~/Desktop` or `~/Downloads` can match
  nothing there.
- **`| grep` filters nothing.** The output goes to stderr, not stdout. Use `2>&1 | grep …`. `grep` then drops output
  lines (content and headers), not files; to leave files out, use `!(…)` in the pattern.
- **High CPU, or each rescan is slow.** There is no ignore list: `**` walks `node_modules/` and, because hidden
  folders match, `.git/` too, once per `--seconds`. Narrow the pattern to the folders you need, or raise
  `--seconds`. Use `-v` to see each scan and how many files it found.
- **`--seconds 0.5` burns CPU.** The value is read as a whole number, so `0.5` becomes `0` and the rescans run back
  to back. Use `1` or more.
- **The first line shows a doubled path.** It joins the pattern to the current folder even when the pattern is
  absolute, so a `~/…` pattern prints the wrong path there. The scan itself uses the right path.
- **A new file shows no text yet.** An empty file prints nothing until it grows. A file in a folder that had no
  match prints at its next write or the next rescan.

## Related

- [tools watchman](../watchman/README.md): folder watches through Facebook Watchman.
- [tools genesis-tools](../genesis-tools/README.md): `logs day` reads the day log, which holds a copy of this tool's
  output.
- [tools task](../task/README.md): runs a command and keeps its logs; `task tail` follows them live.
