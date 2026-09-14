# What makes this test suite slow

State as of 2026-09-15 00:58. Every number here was measured, and the commands that produced
it are given so the next reader can re-measure rather than trust.

This exists because the ubuntu CI step has now outgrown its budget twice. It was raised from
4 to 5 minutes on 2026-09-14 as a mitigation, after seven runs measured 241-260 s against a
240 s limit: the same tree passed or failed by luck, and a budget kill surfaces as the
completion-marker guard reporting a HANG that never happened. Raising it a third time is not
an answer.

## The one number that explains the trend

The suite grew by 154 test files in seven days against 1599 total. That growth is the cost,
and it is measurable.

From CI's own output on a 4-vCPU ubuntu runner (run 34901927895):

```
bun test v1.3.13 (bf2e2cec) 4x PARALLEL
Ran 11275 tests across 1298 files. [274.74s]
```

Summing bun's per-test brackets out of the same log gives 622 s of actual test execution
(median of five runs). With four workers:

```
(622 s + 1298 files x X) / 4 = 274.74 s   ->   X = 368 ms
```

**Every test FILE costs about 368 ms of runner time, or ~92 ms of wall clock, before it
asserts anything.** Adding a test to a file that already exists costs only that test's own
runtime. One hundred new files is about 9 s of ubuntu wall time on their own.

Re-measure it with `python3` over a downloaded log, or read the `Slowest test files` block
in any run's job summary.

## Why a file costs that much: `--parallel` implies `--isolate`

`bun test --parallel=N` runs files across N long-lived worker processes, but `--isolate`
comes with it, so every file gets a fresh module registry. The six `[test].preload` entries
in `bunfig.toml` and the file's entire import graph are therefore re-executed per file, not
once per worker.

Twenty trivial test files (one `expect(1).toBe(1)` each), measured three times:

| Mode | Repo's 6 preloads | No preloads |
|---|---|---|
| serial, shared registry | 87 / 93 / 111 ms | 13 / 15 / 16 ms |
| `--isolate` | 1047 / 1104 / 1254 ms | 17 / 20 / 20 ms |
| `--parallel=4` | 290 / 292 / 346 ms | 28 / 29 / 30 ms |

So bun's isolation machinery is about 1 ms per file. The rest is module evaluation repeating.

**A measured negative result, recorded so nobody repeats the experiment:** trimming the
preload list does NOT help real files. Interleaved A/B over the 147 real test files in
`src/utils/ai`, five reps each, with and without the heaviest preload
(`preload-test-host-effects.ts`, which eagerly imports seven namespaces):

```
A with host-effects    (ms): 7530 6700 5530 7640 5130
B without host-effects (ms): 6310 5970 6310 6770 4690
```

The ranges overlap, and A's minimum is below B's maximum. Real files already import those
modules through the code under test, so the preload is not paying for them twice. The 32 ms
per file measured on trivial files is an upper bound that does not transfer. Do not "optimise"
the preload list on the strength of a trivial-file measurement.

## The three patterns that make one file expensive

Each of these is worth citing on a pull request.

### 1. A real wall-clock wait

`src/utils/oauth/device-flow.test.ts` spent 9.6 s of its 9.75 s asleep. `pollDeviceTokenResponse`
waits `max(1000ms, interval) * 1.2` before its FIRST request, so `intervalSeconds: 0` still
cost 1.2 s, and eight tests each paid it.

The cheap alternative is not a fake timer: it is to use a bound the production code already
honours. The device-code deadline caps that sleep, so a 50 ms deadline makes the one poll
immediate while the loop still runs sleep -> fetch -> validate, because the deadline is only
re-checked at the top of the loop. **9.75 s -> 0.57 s, same 8 tests, same 10 `expect()` calls.**

Look for: `Bun.sleep`, `setTimeout` with a literal, a poll interval, a retry backoff, a
timeout the test waits out on purpose.

### 2. A child process per assertion

`src/git/lib/merged/merged.test.ts` issued **1359 `git` spawns for 33 tests**. At roughly
10 ms per spawn that is 13.6 s of a 13.6 s file: the runtime is spawn overhead and nothing
else. Count them for any suspect file with a preload that wraps `Bun.spawn` and appends its
argv to a log.

The fix is to stop spawning, not to spawn faster. `TestRepo.create()` cost seven processes
(`init`, three `config`, then `add`/`commit`/`rev-parse` for the seed); it now builds one
pristine repo per shape per process and copies the directory, and the first build still runs
the real commands so the template cannot drift. `rev-parse HEAD` after a commit reads the
loose ref off disk and falls back to git for any other layout. **1359 -> 1008 spawns, 33
pass and 103 `expect()` calls unchanged.**

Look for: a helper that shells out inside a loop, a fixture rebuilt per test that could be
built per file, a CLI invoked to read something a file already holds.

`TestRepo` now caches two levels of this, and both are available to any suite:
`TestRepo.create()` copies a pristine repository, and `TestRepo.fromScenario(name, setup)`
copies a whole SETUP. `merged.test.ts` gave 11 of its 31 repositories the same two-commit
feature branch and `cascade.test.ts` opened 6 cases with the same parent/c1/c2 stack, at 8
and 16 git processes every time. **merged 13.56 s -> 8.40 s and 1359 -> 948 spawns, cascade
8.87 s -> 5.57 s, with 33/14 tests and 103/88 `expect()` calls unchanged.**

**`test.concurrent` is NOT a general answer here, and that is measured.** Overlapping
`capture-install.test.ts`'s sixteen cold CLI spawns took it from 5.40 s to 1.11 s on a
16-core developer machine and turned it RED on CI: "cmux refuses an unconfirmed rc edit"
timed out at 5368 ms against the 5000 ms default (run 34908819029). The ubuntu runner has
**four** vCPUs and `--parallel` already uses all of them, so a file has no spare parallelism
to claim — it only takes it from its neighbours. Reserve `concurrent` for tests that WAIT on
something outside the CPU, which is why `mcp-doctor/unknown-tool.contract.test.ts` keeps it:
its seven cases each wait on a separate server's startup handshake.

### 3. An on-demand package install inside a test

`ensurePackages()` prompts before installing, and `promptInstall()` returns `"accept"`
whenever stdin is not a TTY — which is always under `bun test`. A test whose optional
dependency was missing therefore ran `bun add` mid-suite. That is the entire story of the
9836 ms once recorded for `chunker.test.ts` "extracts Python function and class definitions"
against a 5000 ms per-test timeout: `@ast-grep/lang-python` was absent from a worktree's
partial `node_modules`. With all twelve grammar packages declared in `package.json` the same
test measures **4.00 ms on CI**.

`ensurePackages()` now refuses to install under `NODE_ENV=test` (which `scripts/test.ts`
forces), so the failure mode is "the capability is unavailable" rather than a silent ten-second
install that also mutates the tree under test.

Look for: anything that can reach `ensurePackages`, a model download, a browser download, a
grammar fetch.

## How to measure, and the two instruments' disagreement

- **Wall time per file:** `bun run test --profile --jobs 8`. One isolated `bun test <file>`
  per worker, sorted, with a JSON copy under `.claude/work/`. Totals run above a native run
  because each file pays its own process; the ranking is the point.
- **Test time per file:** the `Slowest test files` block in any CI job summary, or the same
  `awk` over a downloaded log. This omits module import and `beforeAll`, so a file that is
  slow purely because it imports a heavy tree ranks low.

They disagree on concurrent files, and the reason matters for
`scripts/ci/test-runtime-guard.ts`: under `describe.concurrent` every overlapping test reports
the whole overlap, so the summed metric counts the same seconds once per test.
`src/mcp-doctor/unknown-tool.contract.test.ts` sums to 19.7 s on CI and measures 2.2 s of real
wall time. The guard exempts such files by reading their source, so a file that later drops
`.concurrent` is guarded again with no list to maintain.

A third trap, and the reason `scripts/ci/test-runtime-guard.ts` resets attribution on
`##[endgroup]`: bun's GitHub reporter opens a group per file, but the run does not end there.
The failure summary reprints every failing test with no header, and `scripts/test.ts` then
starts a second bun process for the load-sensitive files whose output carries no groups at
all. Attributing on the header alone glues all of that onto whichever file printed last —
`legacy-cache.test.ts` read as 23.49 s over 85 tests when it has 17 tests and costs 2.67 s,
and the 85 names belonged to watcher, disk-usage and capture-install. Any hand-rolled `awk`
over that log has the same bug.

Two more traps, both of which produced wrong conclusions while this was being written:

- `--profile` inflates spawn-heavy files 6-10x under `--jobs 8`, because the child processes
  contend. Confirm any suspect with `--jobs 1` before touching it.
- Local wall time on a developer machine swings with load average. Three interleaved runs per
  arm, minimum, and report the spread rather than one number.
