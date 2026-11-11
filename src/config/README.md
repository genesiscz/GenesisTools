# tools config

> **Manage the settings that belong to the whole toolkit, not to one tool.**

`tools config` has two areas: the global profiler, which times what every `tools` command does, and the list of
optional packages you declined to install. Use it to turn profiling on for the scopes you are chasing, or to get a
package prompt back after you answered "no".

Per-tool settings do **not** live here. Each tool owns its own file under `~/.genesis-tools/<tool>/`, for example
`~/.genesis-tools/say/config.json`. AI accounts and credentials live under `~/.genesis-tools/ai/` and in the
encrypted vault at `~/.genesis-tools/security/vault.json` (see `tools ai`).

## Quick start

```bash
tools config                                   # pick an area; without a terminal, print each area's state
tools config profiling                         # show the profiler settings; in a terminal, offer to edit them
tools config profiling --enable --scopes claude-history   # profile one scope from now on
tools config profiling --disable               # turn the profiler off again
tools config packages                          # re-enable optional packages you declined
tools config --readme                          # print this file
```

## Commands

| Command | What it does |
|---------|--------------|
| `tools config` | Pick an area. Without a terminal, print each area's state. |
| `profiling` | Show or change the global profiler settings. |
| `packages` | List the packages you rejected; re-enable some or clear them all. |

In a terminal, the bare command shows a picker of the areas, each with its state, and runs the one you pick.
Without a terminal it prints this and exits 0:

```text
profiling: on, scopes: claude-history
packages: 1 rejected
tools config profiling
tools config packages
```

The profiling state reads `off`, or `on, scopes: <list>` (`all` when no scope is set). The packages state reads
`nothing rejected` or `<n> rejected`.

### `tools config profiling`

| Flag | What it does |
|------|--------------|
| `--enable` / `--disable` | Turn the profiler on or off. Not both at once. |
| `--scopes [list]` | Comma-separated scope names, or `all` (no filter). |
| `--stderr` / `--no-stderr` | Also echo each line to stderr, or not. |
| `--file` / `--no-file` | Write the profiling log file, or not. |
| `--file-path <path>` | Write here, not to the daily log. `""` resets it. |
| `--min-duration-ms <n>` | Leave out duration lines shorter than `n` ms (`n` >= 0). |
| `--detail [mode]` | `phases` (default) or `all`. |
| `--summary-on-exit` | At exit, write each scope's summary table to the log file (and stderr when `--stderr` is on). |
| `--no-summary-on-exit` | Do not print it. |
| `--json` | Print `{ path, stored, resolved }` as JSON. Never opens the edit form. |
| `--edit` | Open the edit form. Needs a terminal. |

`--detail phases` keeps a few timers per command. `--detail all` adds a timer per item, such as each file parse.

What a call does depends on the flags and on whether stdin is a terminal:

- **No flags, in a terminal**: it prints the settings table, then asks "Change profiling settings?" (default no). A
  yes opens a form for enabled, scopes, stderr, detail and summary on exit. `--edit` does the same. The form does not
  set `file`, `filePath` or `minDurationMs`; use the flags for those.
- **No flags, without a terminal**: it prints the settings table only. `--edit` refuses, exits 1, and prints a
  command that sets the fields with flags instead.
- **Any setting flag**: it writes the change, reloads the profiler and prints the table. A read never creates the
  config file.
- **`--scopes` or `--detail` with no value**: in a terminal, a picker. Without one, it exits 1 and prints every
  possible value plus a filled command, for example `Possible: phases, all` and `--detail phases`.
- **An unknown scope name**: it exits 1 and names it, in a terminal too. A stored typo used to match nothing, and
  profiling stayed silent.
- **An unknown detail value**: in a terminal, the picker. Without one, it exits 1 and names the value.

The table has a STORED column (the config file) and a RESOLVED column (what this process uses after the environment
overrides below). The full config path prints on its own line above it.

```bash
tools config profiling --enable --scopes all              # every scope
tools config profiling --enable --scopes sourcemaps --detail all   # one timer per position and per resolver
tools config profiling --min-duration-ms 50 --stderr      # only lines of 50 ms or more, echoed to stderr
tools config profiling --file-path ~/Projects/app/profile.log
tools config profiling --scopes                           # without a terminal: list every scope name, exit 1
tools config profiling --json                             # settings for a script
```

### `tools config packages`

It has no flags. It lists every rejected package. In a terminal it then offers three choices: re-enable specific
packages (a multi-select), clear all rejections so every package prompts again, or exit. Without a terminal it only
lists them and tells you to run it in a terminal.

## How it works

### The profiler

Every `tools` process reads the `profiling` object of `~/.genesis-tools/GenesisTools/config.json` once, applies the
environment overrides, and gets one gate: on or off, and which scopes. When it is off, every timer is a cheap no-op.
`tools config profiling --enable` is the durable switch; the environment variables change one process only.

- **Scopes**: code times its work under a scope name, such as `cli`, `spawn`, `forge-http`, `cache`, `hub-server`,
  `ai-usage`, `hub-pr`, `ai-spend`, `sourcemaps` or `agent-context`. The full list is in
  `src/utils/profile/scopes.ts`, and `tools config profiling --scopes` prints it without a terminal and shows it as a
  picker in one. Empty `scopes` with
  `enabled: true` means every scope.
- **Matching is by substring, in both directions.** `--scopes cli` also turns on `du.cli`, and `--scopes du.engine`
  also turns on `du`.
- **When the `cli` scope is on** (all scopes, or a list that matches `cli`), every command that runs through `runTool`
  writes one `cli` line at exit: the command names (never argument values), `exit=`,
  `cpu=`, peak `rss=`, `caller=app` (GenesisTools.app started it) or `caller=shell`, and the wall time since the
  process started.
- **Line format**: `[profile:<scope>] <label> [outcome] [key=value ...] <duration>`. A duration of 1 s or more prints
  as `1.234s`. The file copy adds `trace=<id>` (when the app started the call) and `pid=<pid>`, so a line joins the
  app's own perf log.
- **Writes are buffered**: lines flush every 250 ms, after 256 lines, and at exit. A line can reach the file a moment
  after the timer stopped.

### Where data lives

| Path | What |
|------|------|
| `~/.genesis-tools/GenesisTools/config.json` | The profiler settings, under `profiling`. |
| `~/.genesis-tools/logs/<date>-profiling.log` | Profiler lines, one file per local day. |
| `~/.genesis-tools/logs/<date>-profiling.log.zst` | An older day, compressed by the daily pass. |
| `~/.genesis-tools/packages/config.json` | `rejected`: the optional packages you declined. |
| `~/.genesis-tools/packages/store/` | The shared store for the heavy optional packages. |

Profiler lines go to their own file, not to the pino day log `~/.genesis-tools/logs/<date>.log`. Only today and
yesterday stay plain. `tools genesis-tools logs profile` reads an older day from its `.zst` file too.

### Optional packages

Some features need heavy packages that most users never use: HuggingFace Transformers (local models), HuggingFace
Inference (image generation), the LanceDB and Qdrant vector stores, and the Stripe client for the youtube server.
They are not installed with the toolkit. A tool installs one with `bun add` the first time it needs it. These go into
the shared store at a pinned version, so every checkout and worktree uses one copy and `package.json` never changes.

The indexer's twelve `@ast-grep/lang-*` grammars are different: they are regular dependencies in `package.json`, so
`bun install` puts them in `node_modules`. The indexer asks before it installs one only when it is missing from
`node_modules`, for example after a partial worktree install.

The prompt you normally see is HuggingFace Transformers, for local transcription, translation and embeddings, in a
terminal. A "no" or a cancel records the package in `rejected`. Later runs skip the install without asking, so the
feature that needs it does not work. `tools config packages` is the only way to undo a "no". Without a terminal
nothing asks: the Transformers install still skips a rejected package, and a missing AST grammar installs with no
check. Nothing in this tool installs a package itself.

## Configuration

The profiler settings, with their defaults:

```json
{
  "profiling": {
    "enabled": false,
    "scopes": [],
    "stderr": false,
    "file": true,
    "filePath": null,
    "minDurationMs": 0,
    "summaryOnExit": false,
    "detail": "phases"
  }
}
```

`filePath: null` means the daily log. Each key is checked on read: a missing or invalid value (a negative
`minDurationMs`, a `detail` other than `phases` or `all`) falls back to its default, and a file that does not parse
gives all defaults. A write stores all eight keys and leaves the other keys of the file alone.

Environment variables override the file for one process:

| Variable | Effect |
|----------|--------|
| `PROFILE=1` | On for every scope, whatever `enabled` says. |
| `PROFILE=0` | Off, even when the file says on. |
| `PROFILE=du,spawn` | On for these scopes only, with the same substring match. |
| `PROFILE_TO_STDERR=0` or `1` | Force the stderr echo off or on. |
| `PROFILE_TO_FILE=<path>` | Write to this path and turn file output on. |
| `GENESIS_TOOLS_HOME=<dir>` | Use `<dir>/.genesis-tools` for every path. Tests use it. |

`PROFILE=1` also accepts `true`, `on`, `yes`, `all` and `*`; `PROFILE=0` also accepts `false`, `off` and `no`.
A `PROFILE` that turns profiling on also echoes to stderr, unless `PROFILE_TO_STDERR=0`. Profiling turned on by the
config file keeps its `stderr` setting.

```bash
PROFILE=spawn tools git merged feat/login   # profile one run; the lines echo to stderr
```

## For agents

- An agent shell has no terminal on stdin, so nothing here prompts. A bare `tools config profiling` prints the
  table, and `--json` prints `{ path, stored, resolved }`. `stored` has the eight config keys. `resolved` has `on`
  in place of `enabled`, `scopes: null` for every scope, and the environment overrides applied.
- Exit codes: 0 on success, the bare `tools config` included. 1 for a missing or unknown `--scopes` or `--detail`
  value, `--edit` without a terminal, `--enable` with `--disable`, or a bad `--min-duration-ms`. The last two print
  `ERROR: <message>` on stderr; `-v` adds the stack.
- To read what the profiler wrote, use `tools genesis-tools logs profile` rather than parsing the file.

## Troubleshooting

- **Profiling is on, but no lines appear.** Check the RESOLVED column: a `PROFILE=0` in the environment wins over the
  file. `file: false` writes nothing to the file, and a high `minDurationMs` drops short lines. A scope name typed
  by hand into `config.json` is not checked, and a typo there matches nothing; set scopes with `--scopes`, which
  rejects unknown names.
- **Lines stop in the middle of a run.** A failed write turns file output off for the rest of that process and prints
  `profiler: file output disabled after a write failure at <path>: <error>` on stderr. Fix the path (`--file-path`
  or `PROFILE_TO_FILE`) or go back to the daily log with `--file-path ""`.
- **More scopes report than you asked for.** Matching is by substring: `cli` also matches `du.cli`. Pick a longer
  name.
- **A feature that needs an optional package does nothing, and the prompt never comes back.** You declined the
  package once. Run `tools config packages` in a terminal and re-enable it.
- **`--edit` exits 1.** It needs a terminal. Set the same fields with flags instead.

## Related

- [`tools genesis-tools`](../genesis-tools/README.md): `logs profile` lists the slow timers from the profiling log
  (`--min-ms`, 1000 by default, plus `--scope`, `--grep`, `--pid` and `--top`).
- [`tools hub`](../hub/README.md): `hub dev monitor` follows the day's profiling log and reports each timer of 1 s or
  more (`--min-profile-ms`) as a slow event.
- [`tools ts`](../ts/README.md): `ts profile` ranks CPU time per function from a run, with no timers added.
- [`tools ai`](../ai/README.md): AI accounts and credentials. [`tools say`](../say/README.md): an example of a tool
  with its own config file.
- [`tools indexer`](../indexer/README.md): asks before it installs an AST grammar that is missing from `node_modules`.
