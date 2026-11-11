# tools watchman

Watch a folder and print one line for each file that changes, with the time of the change. It uses
[Watchman](https://facebook.github.io/watchman/) (Facebook's file watching service), so you need Watchman on the Mac.
Use it to see which files a build, a code generator or an agent touches while it runs.

## Quick start

```bash
tools watchman                            # pick a folder Watchman watches, or the current one
tools watchman -c                         # watch the current folder, no picker
tools watchman -t -c                      # same, and remove the watch again on Ctrl-C
cd ~/Projects/app && tools watchman -c    # watch another folder: cd into it first
tools watchman --help-full                # longer help with examples
```

The tool runs until you press Ctrl-C.

## Options

The tool has no subcommands.

| Option | What it does |
|--------|--------------|
| `-c, --current` | Watch the current folder and skip the picker |
| `-t, --temporary` | Remove the watch on Ctrl-C or SIGTERM (never a watch that existed before) |
| `-?, --help-full` | Print the longer help with examples |
| `-v, --verbose` | Shared GenesisTools flag; this tool writes no extra debug lines |
| `--readme` | Print this file and exit |
| `-h, --help` | Print the short help |

- Without `-c`, the tool shows a picker. It lists every folder Watchman watches now (`watchman: <path>`) and the
  current folder. Type to filter: the text matches the path, case does not matter. You cannot type a path that is
  not in the list.
- **Known problem:** a folder path as an argument (`tools watchman .`, `tools watchman ~/Projects/app`) does not
  work. The code reads one, but Commander rejects it before the code runs: `error: too many arguments. Expected 0
  arguments but got 1: <path>.`, followed by the help. The tool declares no argument, and Commander refuses undeclared ones by default.
  `--help-full` still shows `[directory]` and these examples. Use `cd <folder> && tools watchman -c` instead. Checked
  2026-11-09 01:26 against Commander 15.0.0.
- In zsh, `-?` is a glob, so a bare `tools watchman -?` can fail with `no matches found`. Type `--help-full` or
  quote it (`'-?'`).
- `--help` prints `Usage: index [options]`. Read `index` as `tools watchman`.

### Temporary watches (`-t`)

A watch stays in Watchman after the tool exits, and `watchman watch-list` still shows it. With `-t`, Ctrl-C (or
SIGTERM) sends `watch-del` for the watch root and then exits.

- `-t` never removes a watch that existed before the tool started. The tool checks Watchman's watch list first. When
  the folder is a watch root, or sits inside one, it prints `Directory already watched by Watchman` and leaves the
  watch alone.
- When it cannot read the watch list, it prints `Could not determine pre-existing watches` and also leaves the watch
  alone, as the safe default.
- Each folder in the picker that starts with `watchman:` is already watched, so `-t` only matters for the current
  folder.
- Closing the terminal window (SIGHUP), `kill -9` or a failed subscribe leaves the watch in Watchman. Remove it with
  `watchman watch-del <path>`.
- Watchman can choose a parent folder as the watch root (`watch-project`). `-t` then removes that root, which was not
  watched before.

## Output

```text
Directory of interest: /Volumes/Data/Projects/app/src
Watch established on /Volumes/Data/Projects/app relative_path: src
Subscription mysubscription established
14:02:11 File changed: index.ts
14:02:12 File changed: lib/util.ts
```

- Only files are reported, never folders. Names are relative to the folder you picked.
- Each batch is sorted by modification time, so the newest file is at the bottom.
- A change from today shows only the time. An older one shows the date and the time. Both follow your system locale.
- The first batch lists every file in the folder. Watchman evaluates a new subscription once at the start, and the
  tool does not pass a `since` clock. On a large repository that first batch is long.
- An edit, a new file and a deleted file all print `File changed`. The tool asks Watchman for the `exists` field
  but does not print it.
- A warning from Watchman prints on stderr as `WARN: Warning: <text>`.

## How it works

1. **Folder.** `-c` takes the current folder. Otherwise the picker asks Watchman for its watch list.
2. **Watch.** The tool runs a capability check, which needs `relative_root` (Watchman 3.3 or later). Then it runs
   `watch-project` for the folder. A failed attempt waits 1 s and tries again with a new connection, up to 15 attempts in all.
3. **Subscribe.** It subscribes under the name `mysubscription` to all files below the folder (`relative_root`). A
   failed subscribe also waits 1 s and tries again, up to 15 times (16 attempts in all).
4. **Print.** Every change Watchman sends prints one line per file, until you press Ctrl-C.

The tool talks to the Watchman server through the `fb-watchman` package. The package asks the `watchman` binary on
your PATH for the socket (`watchman get-sockname`), and that starts the server when it is not running. When
`WATCHMAN_SOCK` is set, the package uses that socket and skips the binary.

The tool stores no data of its own. Its log lines go to stderr and also to the GenesisTools day log,
`~/.genesis-tools/logs/<date>.log`. Watchman keeps its own watch list. Nothing calls the network, and nothing costs
money.

### Install Watchman

```bash
# macOS
brew install watchman

# Ubuntu or Debian
sudo apt-get install watchman
```

To build it from source, see <https://facebook.github.io/watchman/docs/install>.

## For agents

- There is no `--json` output, no MCP tool and no plugin skill. Every log line goes to stderr, so pipe with `2>&1`.
  Only the help text, `--readme` and the picker go to stdout.
- The picker needs a terminal. Without one it prints `✘ search prompt requires an interactive terminal` and exits 1. A
  script or an agent must `cd` into the folder and pass `-c`.
- The tool never exits by itself. Run it in the background and stop it with SIGINT or SIGTERM.
- Exit codes:
  - `0`: `--help`, `--help-full` or `--readme`, Ctrl-C at the picker (it prints `Operation cancelled`), or SIGTERM
    after `-t` removed the watch.
  - `1`: a usage error (such as a folder argument), the picker started without a terminal (you forgot `-c`), a
    missing `watchman` binary, 15 failed watch attempts, 15 failed subscribe retries, or a failed `watch-del` in `-t`
    mode.
  - `130`: Ctrl-C while the tool watches, also after `-t` removed the watch.
  - `143`: SIGTERM when `-t` did not install the cleanup (no `-t`, or a watch that existed before).

## Troubleshooting

- **`error: too many arguments. Expected 0 arguments but got 1`.** You passed a folder path. `cd` into the folder
  and run `tools watchman -c`.
- **`✘ search prompt requires an interactive terminal`.** The picker started without a terminal. `cd` into the folder
  and pass `-c`.
- **`Watchman: Watchman was not found in PATH`** (the full line adds the install link). The `watchman` binary is missing, and the tool stops at once
  without the 15 retries. Install it (see above) and check with `watchman version`.
- **`Capability check failed (attempt n/15)`.** The server did not answer, or it is older than 3.3 and has no
  `relative_root`. Check that Watchman runs with `watchman version`, and update it when the version is lower.
- **`Error initiating watch` or `Failed to subscribe` repeats.** Restart the server with `watchman shutdown-server`.
  The next run starts it again.
- **No file changes appear.** The tool reports files only, never folders. Make sure something writes into the folder
  you picked, not into a sibling folder of the same watch root.
- **A watch you no longer want.** `watchman watch-list` shows every watch. `watchman watch-del <path>` removes one.
  Next time, use `-t`.

## Related

- [tools watch](../watch/README.md): print and follow the files that match a glob, with no Watchman needed.
