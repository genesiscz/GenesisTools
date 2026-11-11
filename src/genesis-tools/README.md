# tools genesis-tools

Developer tools for GenesisTools itself. `logs` reads what failed, crashed or ran slow in any `tools` command, and who
ran it: a person in a shell, or an agent with its model, effort and session. `probe` says what of GenesisTools this Mac
has, and which genesis.tools links a click really opens. Use it to triage a misbehaving tool from its records instead
of running it again, and to check a link before you write one.

## Quick start

```bash
tools genesis-tools logs failures                  # failed tool runs of the last 24 hours, newest last
tools genesis-tools logs show <id>                 # one failure in full (an id from `logs failures`, or its leading part)
tools genesis-tools logs stats --by tool,model     # which tools fail most, and under which models
tools genesis-tools logs day --tool ai --since 2h  # warnings and errors one tool wrote to the day log
tools genesis-tools probe md finder                # do note and folder links open here? exit 1 and the fix if not
```

## Commands

### logs: failures, crashes, the day log and profiling

```bash
tools genesis-tools logs failures [filters] [--limit 40]          # alias: logs list
tools genesis-tools logs stats [filters] [--by tool,kind] [--top 30]
tools genesis-tools logs usage [filters] [--top 25]
tools genesis-tools logs show <id> [--since 7d]
tools genesis-tools logs crashes [--since 7d] [--until <when>]
tools genesis-tools logs day [flags]       # --since 1h, --level warn, --tool, --pid, --grep, --limit 100
tools genesis-tools logs profile [flags]   # --since 24h, --min-ms 1000, --scope, --grep, --pid, --top 40
tools genesis-tools logs paths
```

- **`failures`** (alias `list`): the failed runs in the window. It keeps the newest `--limit` and prints them oldest
  first, with the columns TIME, KIND, COMMAND, EXIT, WHO, MESSAGE and ID. WHO is the caller's model, else its agent,
  else `shell`.
- **`stats`**: failure counts, most frequent first, grouped by the `--by` keys: `tool`, `kind`, `command`, `model`,
  `agent`, `message`, `exit`, `day`, `session`. Each group also shows how many sessions hit it, the models, and the id
  of its newest failure.
- **`usage`**: only the `usage` records (command lines commander refused), grouped by command and message, with the
  models that hit each one and up to three example command lines. Each row is a place where the help, an alias or a
  clearer error would have saved a retry. An agent's misuse counts the same as a person's.
- **`show <id>`**: one failure in full. It looks for the id, or its leading part, in the last 7 days (`--since 30d`
  for an older one), interrupts included. It prints the kind, the time, the command line, the exit code, the message,
  the cwd, the run time, the pid and its parent, the checkout, the caller, the app trace id, the stack, the stderr
  tail, and up to 200 day-log lines its pid wrote from one second before the run started to one second after it ended.
- **`crashes`**: the `crash` records, plus the macOS crash and hang reports (`.ips`) of GenesisTools processes in
  `~/Library/Logs/DiagnosticReports`, chosen by file time. The processes are GenesisTools, Genesis, Genesis Markdown,
  GenesisTools Preview, and bun, which runs every `tools` command.
- **`day`**: the pino day log of every tool, filtered by the lowest level (`trace`, `debug`, `info`, `warn`, `error`,
  `fatal`), one tool, one pid, or a text (case-insensitive, anywhere in the record). It keeps the newest `--limit`
  records and prints them oldest first, in local time.
- **`profile`**: the slowest timers in the profiling log, slowest first, at least `--min-ms` long, optionally of some
  scopes only (`cli`, `spawn`, `agent-sessions`, ...). `--grep` matches the label. Profiling lines carry no time of
  day, so `--since` and `--until` select whole local days. Mark lines (`@name`) and summary tables are left out.
- **`paths`**: where today's failure log, day log and profiling log are, and the crash-report folder.

The filters of `failures`, `stats` and `usage`:

| Flag                | Keeps                                                          |
|---------------------|----------------------------------------------------------------|
| `--since <when>`    | records from this point on (default `24h`)                     |
| `--until <when>`    | records up to this point (default now)                         |
| `--tool <names...>` | these tools                                                    |
| `--kind <kinds...>` | these kinds: `usage`, `error`, `crash`, `exit`, `interrupt`    |
| `--command <text>`  | a command path that contains the text (`usage sessions`)       |
| `--agent <agent>`   | `claude-code`, `codex`, `grok`, `copilot`, `unknown` (a shell) |
| `--model <text>`    | a model that contains the text, any case (`sonnet`, `gpt-6`)   |
| `--session <id>`    | a session id or its leading part                               |
| `--exit <codes...>` | these exit codes                                               |
| `--grep <text>`     | a message, arguments or stderr tail with the text, any case    |
| `--interrupts`      | Ctrl-C and SIGTERM endings too (hidden by default)             |
| `--json`            | print JSON instead of the table                                |

A list flag takes commas or spaces: `--tool git,ai` and `--tool git ai` are the same. `--kind interrupt` shows
interrupts without `--interrupts`.

`--since` and `--until` read `30m`, `24h`, `7d` (back from now), `HH:MM` (that time today), `YYYY-MM-DD` (that day's
local midnight) or an ISO time. `HH:MM` is always today and must be in the past, or the window is inverted. Every `logs` command except `paths` and
`show` takes both and `--json`. `show` takes `--since` and `--json`.

```bash
tools genesis-tools logs failures --since 7d --tool git --kind usage,error
tools genesis-tools logs failures --agent codex --model gpt-6 --exit 1
tools genesis-tools logs stats --by command,message --since 2026-11-01 --until 2026-11-08
tools genesis-tools logs usage --agent claude-code --since 7d
tools genesis-tools logs day --level error --grep "database is locked" --since 09:00
tools genesis-tools logs profile --min-ms 5000 --scope cli,spawn --since 3d
```

### probe: what of GenesisTools this Mac has

```bash
tools genesis-tools probe                  # every part and every link kind
tools genesis-tools probe md finder        # only these; exit 1 and the fix command when one is missing
tools genesis-tools probe \
    --url "https://genesis.tools/md/open?path=/tmp/notes.md"   # whether a click on this one link opens it
tools genesis-tools probe --json           # the whole probe for code
```

The names it takes are five parts and four link kinds:

| Name          | What it checks                                                          |
|---------------|-------------------------------------------------------------------------|
| `tools`       | a GenesisTools checkout that `tools` runs                               |
| `app`         | GenesisTools.app in `~/Applications`                                    |
| `router`      | the app is macOS's https handler, and the router has a link host        |
| `markdown`    | an app opens `genesis-md://` links (Genesis Markdown)                   |
| `cmux`        | cmux is installed                                                       |
| `md`          | a link that opens a note in Genesis Markdown                            |
| `finder`      | a link that reveals a folder in Finder                                  |
| `hub`         | a link that opens the hub at a pull request or a commit                 |
| `claude-find` | a link that scrolls a live Claude session to a decision                 |

A link kind opens only when all of these hold: the Mac runs macOS, GenesisTools.app is installed, macOS gives https
links to it, the router config has a link host and a route for that path, and the app or command the route names is
there (Genesis Markdown for `md`, the `tools` CLI for `claude-find`, and cmux only when a route's command names it). The route is judged by the router's own
`route()` on the real config, so a hand-made route counts as much as a preset's. Otherwise the click goes to the
browser, onto a page that does not exist.

When something is missing, the probe prints the command that fixes it:

| Problem                                   | Fix it prints                                    |
|-------------------------------------------|--------------------------------------------------|
| the app is missing or not the https app   | `tools browser-router install`                   |
| the router has no link host or no config  | `tools browser-router link-host <host>`          |
| no route for the link kind                | `tools browser-router presets enable <preset>`   |
| Genesis Markdown is missing               | install Genesis Markdown                         |

For `--url`, a missing route prints `tools browser-router presets` (the list). A missing `tools` checkout or cmux,
and a missing target of a link other than `md`, print no fix command. `browser-router presets enable claude-find`
needs cmux installed.

The presets are `genesis-md`, `finder`, `genesis-hub` and `claude-find`, one per link kind.

## How it works

### Where the data lives

```text
~/.genesis-tools/logs/<date>-failures.jsonl   the failure log: one JSON line per failed run
~/.genesis-tools/logs/<date>.log              the day log: pino JSON records of every tool
~/.genesis-tools/logs/<date>-profiling.log    the profiling log: one line per timer
~/Library/Logs/DiagnosticReports/             macOS crash and hang reports (.ips)
~/.genesis-tools/browser-router/config.json   the router config that probe reads
```

`<date>` is the local day, `YYYY-MM-DD`. Only today and yesterday stay plain: the daily pass stores an older day as
`<name>.zst` (seekable zstd), for all three kinds of day file. Every `logs` command opens both forms
(`dayLogPath` / `listDayLogs` in `src/utils/logger/day-logs.ts`). By hand, `tools compress cat <plain name>` prints
one day file (the plain name finds the `.zst`; pipe it into rg), and `rg -z <pattern> <file>` searches either form.

Both commands read only. Like every tool, a `logs` run still writes its own records to the day log; `probe` writes no
file, the router config included. Nothing here calls the network or costs money.

### The failure log

Every tool run through `runTool` (and the few entry points without commander, through `watchToolRun`) writes one JSON
line per failed run to the failure log (`src/utils/cli/failures/`). Each record is one append, so tools that fail at
the same time never mix their lines. The kinds:

| Kind        | When                                                                                |
|-------------|-------------------------------------------------------------------------------------|
| `usage`     | commander refused the command line: unknown option or command, missing argument, or no subcommand (the help was printed) |
| `error`     | the action threw and `runTool` printed `ERROR: ...`                                 |
| `crash`     | an uncaught exception or rejection; `fatal: false` when the process went on         |
| `exit`      | a non-zero exit with none of the above (the tool printed its own message)           |
| `interrupt` | Ctrl-C or SIGTERM (130, 143), often a harness timeout; hidden unless `--interrupts` |

A run the default signal action kills never reaches its own watcher. Its waiting parent writes that record instead:
the GenesisTools.app launcher (`src/macos/GenesisTools/Sources/Host/LauncherFailures.swift`) on the default path, or
the `tools` wrapper when it spawned a plain bun child (`src/utils/cli/failures/launcher.ts`). The kind is `interrupt`
for SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGKILL, and `crash` for a fault signal (SIGSEGV, SIGBUS, SIGILL, SIGFPE,
SIGABRT, SIGTRAP). Any other signal, such as SIGPIPE from `tools x | head`, is a normal end. Neither parent has the
command definition, so the arguments read `[withheld]` and the command path is empty; the launcher's record has no
caller. Both use the run id in `GENESIS_TOOLS_RUN_ID`, so one run gets one record. A run exec'd straight into bun
(`GENESIS_TOOLS_NO_APP=1`, Linux) has no waiting parent and stays unrecorded.

Each record carries the tool, the command path (names only, never argument values), the arguments with secrets
masked, the exit code, the message, the stack, the last 4,000 characters of stderr (ANSI stripped), the cwd, the pid
and its parent, the run time, the app trace id when GenesisTools.app started it, and the checkout that ran it (the
main one or a worktree). The caller part says who ran it: the agent (Claude Code, Codex, Grok, Copilot, or `unknown`
for a shell), the session id and title, the model and effort (from the session's own transcript and environment,
never guessed), the project, branch and commit. Records from 2026-11-04 on add the session's cwd; records from
2026-11-05 on add the transcript path, the tool call, the subagent, the turn, the account (or the proxy target) and the
T3 Code host. Older records lack these fields and still read.

Secrets: the value of a secret-named flag (`--token x`, `--api-key=x`, and its short alias, even inside `-vtx`) and
any secret-shaped argument become `[redacted]`. The same values are masked where the message, the stack or the stderr
tail echoes them. A secret shorter than four characters cannot be replaced safely, so a text that still echoes one is
withheld whole: `[withheld: it echoes a short secret value]`.

### The day log and the profiling log

Every tool's logger writes pino JSON to the day log. Its times are UTC; `logs day` and `logs show` print local time.
A day log is often 200 MB or more, and a week of them can be gigabytes, so `logs day` hands rg the cheapest pattern
every wanted line must hold (the pid, the tool, a level of `warn` or higher, or the `--grep` text) and parses
only what rg passes. While lines stream past, it holds at most twice `--limit` records. Without rg on PATH it parses
every line, which is slower.

The profiler writes the profiling log only while profiling is on: `tools config profiling --enable` for every run, or
`PROFILE=<scope,scope>` (or `PROFILE=*`) for one run. A timer line reads
`[profile:<scope>] <label> <duration>(ms|s) [trace=<id>] pid=<n>`, with no time of day.

### The probe

`probe` reads the facts once: the `tools` checkout, the app bundle, the https handler, the router config, the app
that opens `genesis-md://` (asked of Launch Services, not Spotlight) and the cmux binary. It then judges one sample
link of each kind on the router's link host. The code is `src/utils/genesis-tools/probe.ts` (`probeGenesisTools()`,
`linkState(url, facts)`), and `.claude/rules/genesis-links.md` says where links are built and what each one falls
back to. A run answers in about 0.3 s (median 317 ms over 116 runs, 2026-10-30).

## Configuration

The tool has no config file of its own.

| Variable                  | Effect                                                              |
|---------------------------|---------------------------------------------------------------------|
| `GENESIS_TOOLS_HOME`      | the home that holds `.genesis-tools/` (tests sandbox it there)      |
| `GENESIS_TOOLS_APP_HOME`  | the home whose `Applications/` holds GenesisTools.app               |
| `GENESIS_TOOLS_NO_APP=1`  | `tools` skips the app launcher; a signal death is then not recorded |
| `GENESIS_TOOLS_NO_EXEC=1` | `tools` waits as the tool's parent, so it records a signal death    |
| `PROFILE`                 | profiler scopes for one run (`cli`, `*`)                            |

The profiler's settings (scopes, minimum duration, a file path) live in `tools config profiling`. The router's link
host and presets live in `tools browser-router`.

## For agents

- Triage from the records first. `logs failures --session <your session id> --json` lists your own failed calls with
  their stderr tails; `logs show <id>` has the stack and the day-log lines of that pid.
- `--json` prints to stdout, with no table:
  - `failures`: an array of the newest `--limit` records, oldest first.
  - `stats`: `{ total, by, groups: [{ key, count, lastAt, lastId, models, sessions }] }`.
  - `usage`: `[{ tool, command, message, count, models, examples }]`.
  - `show`: `{ failure, dayLog }`, where `dayLog` holds the raw pino records.
  - `crashes`: `{ failures, reports: [{ path, process, at }] }`.
  - `day`: the raw pino records, oldest first.
  - `profile`: `[{ day, scope, label, ms, traceId, pid }]`, slowest first.
  - `probe`: `{ version: 1, at, platform, tools, app, router, markdown, cmux, links }`, with `at` in epoch
    milliseconds, `tools: { path }`, `app: { installed, path }`,
    `router: { httpsHandler, defaultHandler, configured, linkHost }`, `markdown: { path }` and `cmux: { path }`; each entry of `links` is
    `{ opens, problem, reason, action }`, with `problem` one of `not-darwin`, `app-missing`, `not-https-handler`,
    `no-link-host`, `no-route`, `target-missing`. `probe --url` prints that one link state.
- Exit codes: 0 on success. A `logs` command exits 1 with `ERROR: <message>` on stderr for an unknown `--kind`, `--by` or `--level`, a
  `--since` or `--until` it cannot read, an inverted window, or an id it cannot find. The number flags (`--limit`,
  `--top`, `--min-ms`, `--pid`, `--exit`) are not checked: a value that is not a number drops the limit or matches
  nothing, and the command exits 0. `probe` exits 1 when a part or link kind you named is missing, when the `--url` link does not open,
  or when a name is unknown. A bare `probe` exits 0 even when something is missing; `probe --json md` prints the
  whole probe but still exits 1 when `md` links do not open.
- The genesis-tools-mods plugin runs `tools genesis-tools probe --json` once per 30 minutes per session
  (`plugins/genesis-tools-mods/hooks/genesis.ts`) and builds its links only for the kinds that open. A failed spawn
  means no CLI, so no links and no control that runs `tools`. Start the probe from `session.start` or a timer, never
  from a render: on 2026-10-23 a render aborted the first probe, and the plugin kept "no link opens" for 30 minutes in
  every session.

## Troubleshooting

- **`no failure with id ... in the last 7d`**: the failure is older. Pass `--since 30d`.
- **A run a signal killed has no record**: it was exec'd straight into bun (`GENESIS_TOOLS_NO_APP=1`, or Linux), so no
  parent waited for it. Set `GENESIS_TOOLS_NO_EXEC=1` to make the `tools` wrapper wait as its parent and record it.
- **A record reads `[withheld]` and has no command**: a parent wrote it after a signal death. It never has the
  command definition, so it cannot tell a secret argument from a plain one.
- **An interrupt does not show**: interrupts are hidden by default. Pass `--interrupts` or `--kind interrupt`.
- **`logs profile` prints no rows**: profiling was off, the timers were shorter than `--min-ms` (1000 by default),
  `tools config profiling --file-path`, `PROFILE_TO_FILE` or `--no-file` send the lines to another file or nowhere, or a
  config `--min-duration-ms` above `--min-ms` dropped the shorter timers when they were written.
- **`logs profile` shows timers from before `--since`**: profiling lines carry no time of day, so the window selects
  whole days.
- **`logs day` is slow**: rg is not on PATH, so every line is parsed. Install ripgrep, or narrow with `--tool` or
  `--pid`.
- **`rg over the day logs failed`**: a `.zst` day did not open or decode, or rg ran past its 120 s limit. Narrow the
  window.
- **`--since ... is after --until ...`**: the window is inverted. A bare date means that day's midnight, so
  `--until 2026-11-08` ends at the start of that day.
- **You need the debug lines** (the rg fallback, the stack of an `ERROR:`): add the root option `-v, --verbose`, for
  example `tools genesis-tools -v logs day --tool ai`.
- **`probe` says a link kind is missing**: run the fix command it prints under the table, then probe again.

## Related

- [browser-router](../browser-router/README.md): the router, its link host and presets, which `probe` checks.
- [compress](../compress/README.md): the daily pass that stores old day files as `.zst`, and `compress cat`.
- [config](../config/README.md): `tools config profiling`, which turns the profiling log on.
