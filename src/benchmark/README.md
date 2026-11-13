# tools benchmark

`tools benchmark` times shell commands against each other with [hyperfine](https://github.com/sharkdp/hyperfine): you
save a named suite of two or more commands, run it again later, and compare the run with an earlier one. The same
folder ships an in-process measurement library (`@app/benchmark/lib`) that bench scripts use to measure CPU time, child
processes, `node:fs` calls and event-loop stalls against a git-tracked baseline.

## Quick start

```bash
# Install hyperfine once: the runner refuses to start without it
brew install hyperfine

# Save a suite of commands to compare, each as "label:command"
tools benchmark add search "grep:grep -r TODO src" "rg:rg TODO src" --cwd ~/Projects/app

# Run the suite and save today's result
tools benchmark search

# Later: run it again and compare with the last saved run
tools benchmark search --compare

# List every suite with its type, command count and labels
tools benchmark list

# Browse the saved results of one suite, newest first
tools benchmark history search
```

`tools benchmark` with no argument opens a menu that picks a suite and an action (see
[Interactive mode](#interactive-mode)).

## Commands

### Run a suite

There is no `run` subcommand. The suite name is the first argument: `tools benchmark <suite> [flags]`. With no suite
name, the tool opens an interactive menu (see [Interactive mode](#interactive-mode)).

| Flag | What it does |
|---|---|
| `--compare` | Compare with the newest saved result of the suite |
| `--runs <n>` | Exact number of timing runs |
| `--warmup <n>` | Number of warmup runs before the timing runs |
| `--no-warmup` | No warmup runs, the same as `--warmup 0` |
| `--only <label>` | Time only the command with this label |
| `--setup <cmd>` | Run once before the timing runs of each command |
| `--prepare <cmd>` | Run before every timing run |
| `--conclude <cmd>` | Run after every timing run |
| `--cleanup <cmd>` | Run after all runs of each command |
| `--cwd <dir>` | Working directory for the commands |
| `-v, --verbose` | Verbose logging |
| `--readme` | Print this README and exit |

- A flag on the command line wins over the value saved in the suite. The suite value wins over the built-in default.
- `--warmup` defaults to 3. `--runs` defaults to the hyperfine choice, which is at least 10 runs.
- A hook flag (`--setup`, `--prepare`, `--conclude`, `--cleanup`) replaces the suite-level hook for this run only. A
  per-command hook saved with `--prepare-for` and its siblings still wins for its own command.
- An `--only` run saves its result in a separate file, so it never replaces the result of a full run.

```bash
# Time one command of the suite, ten runs, no warmup
tools benchmark search --only rg --runs 10 --no-warmup
```

### Manage suites

| Command | What it does |
|---|---|
| `add <name> <label:cmd>...` | Save a custom suite (two or more commands) |
| `edit <name> [flags]` | Change a custom suite |
| `remove <name>` | Delete a custom suite (its results stay on disk) |
| `list` | Table of every suite: name, type, command count, labels |
| `show <name>` | The suite's settings, hooks, commands and last result |

`add` takes these flags. Every repeatable flag can be given more than once.

| Flag | What it saves |
|---|---|
| `--runs <n>` | Default number of timing runs |
| `--warmup <n>` | Default warmup count (3 when not set) |
| `--setup <cmd>` | Suite-level setup hook |
| `--prepare <cmd>` | Suite-level prepare hook |
| `--conclude <cmd>` | Suite-level conclude hook |
| `--cleanup <cmd>` | Suite-level cleanup hook |
| `--cwd <dir>` | Working directory |
| `--prepare-for <label=cmd>` | Prepare hook for one command (repeatable) |
| `--conclude-for <label=cmd>` | Conclude hook for one command (repeatable) |
| `--cleanup-for <label=cmd>` | Cleanup hook for one command (repeatable) |
| `--env <KEY=val>` | Variable for every command (repeatable) |
| `--env-for <label:KEY=val>` | Variable for one command (repeatable) |

`edit` takes the same `--runs`, `--warmup`, hook, `--cwd`, `--env`, `--*-for` and `--env-for` flags, which set or
replace a value. It adds these:

| Flag | What it does |
|---|---|
| `--add-cmd <label:cmd>` | Add a command, or replace the text of one (repeatable) |
| `--remove-cmd <label>` | Remove a command by label (repeatable) |
| `--clear-setup` | Remove the setup hook |
| `--clear-prepare` | Remove the suite-level prepare hook |
| `--clear-conclude` | Remove the suite-level conclude hook |
| `--clear-cleanup` | Remove the suite-level cleanup hook |
| `--clear-cwd` | Remove the working directory |
| `--clear-env` | Remove all suite-level variables |

### Browse results

`history <suite>` lists the saved results of a suite, newest first: the date, `full` or `partial` (an `--only` run),
and the mean time of each command.

| Flag | What it does |
|---|---|
| `--limit <n>` | Number of results to show (default 10) |
| `--compare <dates>` | Compare two days: `A..B`, or `A` against the newest |

```bash
tools benchmark history search --limit 30
tools benchmark history search --compare 2026-10-01..2026-11-01
tools benchmark history search --compare 2026-10-01
```

In a comparison, the first date is "Previous" and the second (or the newest) is "Current". The delta is red when the
current mean is slower and green when it is faster. A date is matched as text in the result file names, so it can pick
a partial file (see [Troubleshooting](#troubleshooting)).

### Built-in suites

Two suites ship in the code. `add`, `edit` and `remove` refuse their names.

- `startup` times `tools --help`, `tools port 99999` and `tools notify test --sound default`.
- `notify` times `osascript -e 'display notification "bench"'` against `terminal-notifier -message bench -title bench`.

### Write a suite

A command is `label:command`. The text before the first colon is the label, and the rest is the command, so a label
cannot contain a colon but a command can. A suite needs at least two commands, because it exists to compare them.
`add` with the name of an existing custom suite replaces that suite completely.

```bash
tools benchmark add typecheck \
    "tsc:bunx tsc --noEmit" \
    "tsgo:bunx tsgo --noEmit" \
    --cwd ~/Projects/app \
    --runs 5 \
    --warmup 1 \
    --setup "bun install" \
    --prepare-for "tsc=touch src/index.ts" \
    --env NODE_ENV=production \
    --env-for "tsgo:GOMAXPROCS=4"
```

- **Hooks** go to hyperfine as its `--setup`, `--prepare`, `--conclude` and `--cleanup` options. When one command has
  its own hook of a kind, every command gets a hook of that kind: its own, else the suite's, else `true`.
- **Variables** are put in front of the command as `KEY=value`, with the value shell-quoted. A command's own variable
  wins over a suite variable of the same name.
- **The working directory** is resolved when the suite runs, against the directory you run it from. Save an absolute
  path (an unquoted `~/...` is expanded by the shell before the tool sees it).
- **The suite name** goes into the result file name unchanged. Only an `--only` label is cleaned. Use only letters,
  digits, `_` and `-` in a suite name. A `/` points hyperfine's `--export-json` at a folder under
  `~/.genesis-tools/benchmarks/` that does not exist, so the run cannot save its result.

#### What `edit` does, in order

1. It sets the plain values (`--runs`, `--warmup`, hooks, `--cwd`), then applies the `--clear-*` flags. A clear flag
   wins over a set flag for the same hook or for the working directory.
2. It merges `--env` into the suite variables. `--clear-env` ran in step 1, so `--clear-env --env KEY=val` leaves only
   the new variables.
3. It applies `--add-cmd`, then `--remove-cmd`. `--add-cmd` with an existing label replaces only the command text and
   keeps that command's hooks and variables. `--remove-cmd` with an unknown label prints a warning and goes on.
4. It refuses the whole edit, and saves nothing, when fewer than two commands remain.
5. It applies `--prepare-for`, `--conclude-for`, `--cleanup-for` and `--env-for`. A label that is not in the suite is
   skipped: `--env-for` prints a warning, the hook flags say nothing.

`edit` checks that `--runs` is a positive integer and `--warmup` is zero or more. No flag removes a per-command hook or
variable. To remove one, run `add` again with the same suite name.

### Interactive mode

`tools benchmark` with no argument opens a menu. Pick a suite, then an action:

- **Run benchmark** or **Run and compare with last result**. The tool asks for the number of runs (empty means the
  suite's default, else the hyperfine choice) and the warmup count (`0` means none). The warmup prompt defaults to 3,
  not to the suite's saved warmup, so type the saved value if you want it.
- **Show suite details** and **View result history**, the same output as `show` and `history`.
- **Edit suite** and **Delete suite**, for custom suites only. Edit offers the hooks (set or clear), the working
  directory (empty clears it), the default runs and warmup, and adding or removing a command. Delete asks first.

The menu needs a terminal. Without one, the tool exits 1 and prints the command to run instead.

## How it works

- **The runner** builds one hyperfine call per run: `--warmup`, `--runs`, the hooks, `--ignore-failure`,
  `--export-json`, and one `--command-name <label> <command>` per command. Hyperfine prints its progress to your
  terminal. The tool then prints a table of mean, standard deviation, minimum and maximum per command, and with
  `--compare` a second table with the previous mean and the change in percent.
- **`--ignore-failure`** means a command that exits non-zero is still timed, and the run still succeeds. A typo in a
  command gives you the time of a failure. Run each command once by hand before you trust its number.
- **Suites** live in `~/.genesis-tools/benchmark/config.json` as `{ "suites": [ ... ] }`. Only custom suites are
  stored there; the built-in suites live in [`lib/suites.ts`](lib/suites.ts).
- **Results** live in `~/.genesis-tools/benchmarks/` (plural), one JSON file per suite and day:
  - `<suite>-<YYYY-MM-DD>.json` for a full run;
  - `<suite>-<label>-<YYYY-MM-DD>.json` for an `--only` run, where every label character outside `a-z`, `A-Z`, `0-9`,
    `_` and `-` becomes `_`.
- **One file per day.** The date in the file name is the UTC date. A second run on the same day overwrites the first,
  so `history` keeps the last run of each day. `--compare` reads the old file before the run, so a same-day comparison
  still works.
- **The result file** holds `{ "suite", "date", "results" }`. `results` are the rows hyperfine exported
  (`command`, `mean`, `stddev`, `median`, `user`, `system`, `min`, `max`, `times` and more), with times in seconds.
  It is plain JSON, so you can diff it with any tool.
- **What it needs:** `hyperfine` on `PATH` (`brew install hyperfine`). The built-in `notify` suite also needs
  `terminal-notifier`. The tool makes no network calls of its own and costs nothing.
- **The `startup` suite sends notifications.** Every warmup and timing run of `tools notify test --sound default`
  shows a notification and plays a sound, so one run of the suite makes at least 13 of them.

## Configuration

The suites are the configuration. Change them with `add`, `edit` and `remove`. You can also edit
`~/.genesis-tools/benchmark/config.json` by hand. Each suite has these keys:

```json
{
    "suites": [
        {
            "name": "search",
            "commands": [
                { "label": "grep", "cmd": "grep -r TODO src" },
                { "label": "rg", "cmd": "rg TODO src", "prepare": "sync", "env": { "RIPGREP_CONFIG_PATH": "" } }
            ],
            "runs": 10,
            "warmup": 3,
            "setup": "bun install",
            "prepare": "true",
            "conclude": "true",
            "cleanup": "true",
            "cwd": "/opt/projects/app",
            "env": { "LC_ALL": "C" }
        }
    ]
}
```

Only `name` and `commands` are required. A command can carry `prepare`, `conclude`, `cleanup` and `env`.

`GENESIS_TOOLS_HOME` moves both folders: the tool then uses `$GENESIS_TOOLS_HOME/.genesis-tools/benchmark/` and
`$GENESIS_TOOLS_HOME/.genesis-tools/benchmarks/`.

## In-process measurement library

Everything above wraps **hyperfine**, which times a command from the outside. That cannot answer the questions a
CPU-hog investigation asks: what does a long-lived daemon burn while idle, how many child processes does one call
start, how many `stat` calls does a scan make, and did anything block the event loop.

`src/benchmark/lib/` carries a second, independent surface for that. Import it as `@app/benchmark/lib`; it pulls in no
CLI or prompt code. The hyperfine runner (`runner.ts`, `suites.ts`, `results.ts`) is not re-exported there on purpose,
because it pulls in the prompts. Import it from `@app/benchmark/lib/runner` when you need it.

| Module | Answers |
|---|---|
| [`process-sample.ts`](lib/process-sample.ts) | What does this process burn over a known window? |
| [`spawn-counter.ts`](lib/spawn-counter.ts) | How many child processes did this code start? |
| [`fs-counter.ts`](lib/fs-counter.ts) | How many `node:fs` calls did this code make? |
| [`loop-stall.ts`](lib/loop-stall.ts) | Did anything block the event loop, and for how long? |
| [`baseline.ts`](lib/baseline.ts) | Is the "after" number better than the recorded "before"? |
| [`signal.ts`](lib/signal.ts) | Is this pid still the process I measured, before I signal it? |

```typescript
import { compareToBaseline, formatComparison, sampleProcess, withSpawnCounter } from "@app/benchmark/lib";

const idle = await sampleProcess(daemonPid, { windowMs: 30_000 });
const { count } = await withSpawnCounter(() => refreshStatusline());
const cmp = await compareToBaseline({
    name: "statusline",
    metrics: { idleCpuPercent: idle.cpuPercent, spawns: count },
    tolerancePct: 10,
});
out.println(formatComparison(cmp));
```

### The functions

- `sampleProcess(pid, { windowMs })` takes two CPU-time snapshots of a process a known interval apart. It returns
  `{ pid, windowMs, cpuTimeMs, cpuPercent, rssBytes, threads, alive }`. `cpuPercent` is 100 for one fully busy core and
  200 for two. `windowMs` is the window actually measured, which under load can be longer than the one you asked for.
  Memory and threads are read at the end of the window. `alive` is false when the pid could not be read at either end.
  The process layer (`src/utils/process/processes.ts`) picks the reader for the platform.
- `sampleSelf({ windowMs, countThreads? })` measures the current process with `process.cpuUsage()`, which is exact and
  costs nothing. Prefer it over `sampleProcess(process.pid, ...)` when the code under test runs in-process.
  `countThreads: false` skips the thread count in a hot loop and reports `threads: 0`.
- `countThreads(pid)` reads the thread count of a process from the process layer. It returns 0 when the platform
  cannot report the count.
- The parsers `parseCpuTime`, `parseProcStatCpuMs`, `parseProcRssBytes` and `parseProcThreads` are re-exported from
  the process layer.
- `withSpawnCounter(fn)` returns `{ result, count, spawns }`. Each spawn is `{ cmd, sync, at }`, where `at` is the
  milliseconds since the counter started.
- `withFsCounter(fn)` returns `{ result, calls, total }`, with per-method counts such as
  `{ statSync: 139741, "promises.readFile": 3 }`. It counts 11 synchronous methods (`statSync`, `lstatSync`,
  `readdirSync`, `readFileSync`, `existsSync` and others) and 8 `fs.promises` methods.
- `monitorLoopStalls({ tickMs? })` starts a timer (every 10 ms by default) and returns a monitor. `stop()` returns
  `{ windowMs, ticks, maxStallMs, p99StallMs, stallsOver(thresholdMs) }`. The timer is unref'd, so a monitor you forget
  to stop never holds the process open, and `stop()` is safe to call twice.
- `signalVerified(pid, expected, signal)` sends a signal only when the pid runs the expected command line (a string
  or a predicate) at the moment it checks. A pid the kernel gave to another process before that check is skipped and
  reported. The check and the signal are two separate calls, so this is best effort: a pid reused between them, or a
  replacement that runs the same command line, can still be signalled. `stillRuns(pid, expected)` is the same check
  for a wait loop.
- Both counters restore what they patched in a `finally`, so a throwing `fn` leaves `Bun.spawn` and `node:fs` as they
  were, and the error goes on to the caller.

### Baselines

- `recordBaseline({ name, metrics, notes? })` writes the "before" numbers with their provenance: the commit
  (`git rev-parse --short HEAD`, or `unknown`), the 1, 5 and 15 minute load average and the host name. It overwrites a
  baseline of the same name but keeps its runs, because they are the evidence of the earlier fixes.
- `recordRun({ name, metrics, change?, notes?, commit?, capturedAt?, loadAvg? })` appends one measured run to the
  baseline's `runs`, oldest first. It refuses when the baseline does not exist: a run with no "before" proves nothing.
- `readBaseline(name)` returns the baseline, or `null` when it was never recorded or does not parse.
- `compareToBaseline({ name, metrics, tolerancePct, lowerIsBetter?, floor? })` compares fresh numbers with the
  baseline, and `formatComparison(cmp)` renders the result as a table with an `ok` or `REGRESSED` status per metric.
- `baselinePath(name)` is `<repo>/scripts/benchmarks/baselines/<name>.json`. A name starts with a letter or a digit and
  holds only letters, digits, dots, dashes and underscores, so a caller cannot write outside the folder.

The comparison rules:

- Every metric is lower-is-better by default: CPU milliseconds, spawn counts, fs calls, stall milliseconds. When you
  pass `lowerIsBetter`, only the metrics in that list stay lower-is-better, and every other metric becomes
  higher-is-better (throughput, cache hit rate).
- A metric passes when it stays within `tolerancePct` of the baseline. Use 10 % unless the metric argues otherwise; a
  count that should not move takes 0.
- `floor` is an absolute tolerance per metric, in the metric's own unit. A change smaller than the floor passes,
  whatever the percentage says. A percentage gate means nothing on a tiny value: 0.16 % of a core going to 0.19 % is a
  23 % "regression" and 1.8 ms of CPU over five seconds, which is noise.
- The comparison is `ok` only when the baseline exists, no metric is present on only one side, and every metric passes.
  A missing baseline is a failure, never a silent pass.

Baselines are git-tracked under [`scripts/benchmarks/baselines/`](../../scripts/benchmarks/baselines/), so a "before"
number outlives the branch that produced it. Do not delete a baseline because it looks old: an old number is the
evidence that a regression happened. The file format, with an example of `runs`, is in
[`scripts/benchmarks/baselines/README.md`](../../scripts/benchmarks/baselines/README.md).

### What each counter cannot see

Both counters report a **floor**, never a total, and each module's JSDoc says why.

- `withSpawnCounter` patches only `Bun.spawn` and `Bun.spawnSync`. Measured on Bun 1.3.13, every `node:child_process`
  entry point funnels into those two (`exec`, `execFile` and `spawn` into `Bun.spawn`; `execSync`, `execFileSync` and
  `spawnSync` into `Bun.spawnSync`), so patching `node:child_process` as well would double-count. `Bun.$` reaches the
  OS through a native path and is invisible. Native addons and `posix_spawn` from C are invisible too.
- `withFsCounter` patches the methods on the `node:fs` module object and on `fs.promises`. A module written as
  `import { statSync } from "node:fs"` binds the function value at import time and is invisible;
  `import fs from "node:fs"` plus `fs.statSync(...)` is counted. A reference captured before the window opened
  (`const stat = fs.statSync`) is invisible. `Bun.file` and `Bun.write` are native and are invisible. To count a
  module that uses named imports, change it to `import fs from "node:fs"` first, or measure it with `sampleProcess`.

### Why CPU time and not wall time

`ps %cpu` on macOS is a decayed average over a process's whole life, so a daemon that spun hard yesterday still reads
high today. `sampleProcess` takes two CPU-time snapshots a known interval apart instead, which cannot be gamed that
way. Wall time on the development Mac swings with load average (see
[`docs/benchmarks-cpu.md`](../../docs/benchmarks-cpu.md)), so CPU time and call counts are the metrics a baseline
should hold. If a wall-time number has to go in, record the minimum, median and maximum of at least five interleaved
runs, never a single sample.

### Bench scripts

The scripts that use this library live in `scripts/benchmarks/<area>/<script>.ts`. Each one measures and prints with
no flag, records a baseline with `--baseline`, and compares with `--compare`, exiting non-zero on a regression. Some
also take `--record-run "<the change>"`, which measures, compares and appends the run to the baseline's history. The
shared argument parser and finisher (`parseBenchArgs`, `finishBench`) are in
[`scripts/benchmarks/fs/shared.ts`](../../scripts/benchmarks/fs/shared.ts). The conventions (interleaved arms, five or
more samples for a timing metric, `uptime` beside the numbers) are in
[`scripts/benchmarks/README.md`](../../scripts/benchmarks/README.md).

- `finishBench` compares with a 15 % tolerance, plus the per-metric floors the script passes. A script gates at
  15 %, not at the 10 % that the comparison rules above suggest for your own calls.
- `parseBenchArgs` also reads `--json` (print the runs, the median metrics and the comparison as JSON),
  `--runs <n>` (the full runs to take the median of, default 3) and `--warmup <n>` (discarded runs before them,
  default 1). `--files <n>` (default 20) is used only by `tools-watch.ts`.

```bash
# Measure again and compare with the recorded baseline
bun scripts/benchmarks/fs/tools-watch.ts --compare
```

Record with `--baseline` only for a new baseline. Recording again replaces the old "before" numbers, and those numbers
are the evidence that a regression happened.

Run one script at a time: two benchmarks in flight skew each other. A load average above about 30 on the development
Mac turns every timing metric into noise, so note `uptime` before each run.

## For agents

- **No `--json` flag.** The machine-readable output is the result file: read the newest
  `~/.genesis-tools/benchmarks/<suite>-<YYYY-MM-DD>.json`.
- **No menu without a terminal.** Always pass the suite name: `tools benchmark <suite>`.
- **Exit code 0** when hyperfine finished, even when a timed command failed (`--ignore-failure`). Two cases only
  print a message and also exit 0: `--compare` with no earlier result (`No previous results to compare against.`),
  and `history` for a suite with no results.
- **Exit code 1** for any of these:
  - an unknown suite, a missing hyperfine, a `--cwd` that does not exist, a hyperfine failure, or an `--only` label
    that is not in the suite;
  - a malformed `label:command` or `KEY=value`, an `edit --runs` that is not a positive integer, or an
    `edit --warmup` that is not an integer of 0 or more;
  - a `history --compare` date with no result file, or a `--compare` value with no first date;
  - a change to a built-in suite, or a suite left with fewer than two commands;
  - a usage error from Commander: too many arguments, a missing argument, or an unknown option.
- **Measure a code change with the library, not with `tools benchmark`.** Wall time is noise on a loaded Mac; CPU time
  and counts are not. The repository's performance skill names this harness in
  [`measuring.md`](../../.claude/skills/performance/references/measuring.md).
- The tool has no MCP tools and no node-repl toolset.

## Troubleshooting

- **`hyperfine is required but not installed.`** Install it with `brew install hyperfine`.
- **`error: too many arguments. Expected 1 argument but got 2: run, <suite>.`** (from `tools benchmark run <suite>`)
  or **`Suite "run" not found.`** (from a bare `tools benchmark run`). There is no `run` subcommand, so the tool reads
  `run` as a suite name. Run `tools benchmark <suite>`.
- **`Interactive mode requires a TTY.`** The menu needs a terminal. Pass the suite name.
- **`Working directory does not exist: <path>`.** A relative `--cwd` is resolved against the directory you run the
  tool from. Save an absolute path with `edit <suite> --cwd <path>`.
- **A command fails, but the run succeeds and the time is tiny.** Hyperfine runs with `--ignore-failure`. Run the
  command once by hand and fix it.
- **Only one result for a day with two runs.** Results are kept per suite and day, and the later run overwrites the
  earlier one.
- **`--compare` or `show` reads an `--only` run.** Without `--only`, both take the newest result file of the suite,
  which can be a partial file. Its missing commands show a dash. Compare like with like: pass the same
  `--only <label>` again.
- **`history --compare` reads the wrong file.** It takes the newest result file whose name contains the text you
  give. That file can be an `--only` file, or a file of a suite with a longer name (`api-fast` under `api`), from the
  same day. Any text works, so `--compare 2026-10` takes the newest October file. `history` has no `--only` to narrow
  the match. To compare two full runs, read the files in `~/.genesis-tools/benchmarks/` directly.
- **One suite's results appear under another.** Results are matched by file name, so the results of a suite named
  `api-fast` also show up in `history`, `show` and `--compare` of a suite named `api`. Do not name a suite as another
  suite's name followed by `-`.
- **`Suite "<name>" not found.` from `history` after `remove`.** The result files stay in
  `~/.genesis-tools/benchmarks/`, but `history` needs the suite. Add the suite again, or read the files directly.
- **`Cannot overwrite built-in suite`, `Cannot edit built-in suite` or `Cannot delete built-in suite`.** `startup`
  and `notify` are fixed. Add a custom suite under another name.
- **`A benchmark suite needs at least 2 commands to compare.`** Give `add` two or more `label:command` arguments.

## Related

- [`tools doctor`](../doctor/README.md): `tools doctor cpu` samples CPU time twice and lists what spun in between.
- [`tools du`](../du/README.md): its native core has its own hyperfine bench (`src/du/native/bench.sh`) and rules in
  [`docs/benchmarks-du.md`](../../docs/benchmarks-du.md).
- [`docs/benchmarks-cpu.md`](../../docs/benchmarks-cpu.md): the CPU campaign that this library was built for, with
  every measured number.
