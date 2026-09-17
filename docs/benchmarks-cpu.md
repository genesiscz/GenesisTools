# CPU-hog benchmarks

State as of 2026-09-16 20:30. Every number below is a median over interleaved runs on this Mac,
recorded with the in-process harness in `src/benchmark/lib` (`sampleProcess`, `sampleSelf`,
`withSpawnCounter`, `withFsCounter`, `monitorLoopStalls`, `recordBaseline`, `compareToBaseline`
with an absolute `floor` per metric). Baselines are git-tracked JSON under
`scripts/benchmarks/baselines/<name>.json`; every script takes `--baseline` to record and
`--compare` to gate. CPU time and counts are the metrics; wall time on this machine swings with
the load average and is reported, never gated. The rule that came out of this work is the
"Never spin" section of `CLAUDE.md`; the detection side is `bun scripts/ci/lint-rules.ts`
(timers under 100 ms including identifier-bound constants, `sleepSync` in a loop, a Swift `.wait()`
without a timeout) and `tools doctor cpu` (two `ps -o cputime` samples, what burned a core in
between; opt-in, not in the default doctor suite).

PR #404 ships the measurement library, lint-rules, `tools doctor cpu`, wakeful ticks, `fs/watch`
waits, macos-resources batching, daemon/agent-sessions waits, and lazy CLI registration. Rows
marked **sibling** were measured on the campaign branch and land in other PRs (youtube WorkerPool
in #399, statusline in #400, notifications/app reap and Swift waits in #401). Do not read those
rows as "this PR fixed that."

## The incident that started it

A GenesisTools.app `--rpc` face whose `RunLoop.run(mode:before:)` had no input sources returned
at once, spun at 60% of a core for 1 h 03 m, and held the Launch Services registration, so every
notification click went to it and was swallowed. The reap that catches that shape is in the
notifications/app PR, not here.

## Results per area

| Area | Script | Before | After |
|---|---|---|---|
| Youtube pipeline workers (**sibling #399**) | `scripts/benchmarks/youtube/pipeline-idle.ts` | 48 workers polling SQLite every 250 ms: 182 idle claims/s, 0.50% CPU idle | one on-demand `WorkerPool`: 0 idle claims, 1 statement/s, 0.18% CPU; burst first start 18 ms to 0.3 ms, drain 24.7 ms to 6.2 ms |
| macos-resources TUI | `scripts/benchmarks/macos-resources/spawn-storm.ts` | one `ps` and `lsof` fork per process per tick: 10470 spawns/min, 4.50% CPU | one batched `ps` + `lsof` per refresh, windowed table: 120 spawns/min, 2.50% CPU, RSS 145 to 192 MB (accepted) |
| `tools watch --follow` | `scripts/benchmarks/fs/tools-watch.ts` | 50 ms stat loop, chokidar polling, watchers rebuilt per rescan: 1.6% idle CPU | native events, watchers added once, size sweep per `--seconds`: 0.8% idle CPU, new-file latency -37% |
| sub-100 ms polls and sync waits | `scripts/benchmarks/polls/*.ts` | agents request wait 44 reads/s at 10.5% CPU; codex control loop 48 exists checks/s; `waitFor` stall 1055 ms; teams launch stall 4144 ms; agents-bridge register 17 spawns | 1.3 reads/s at 0.9% CPU; 0 exists checks/s (wake on the file); stall 39 ms; stall 3 ms; 1 spawn |
| Claude Code statusline (**sibling #400**) | `scripts/benchmarks/statusline/current-statusline.ts` | shell script, ~75 processes per render: 826/743/883/823 ms median across four repos, ~660 ms user CPU | `tools ai statusline` in-process: 109/87/86/84 ms, ~103 ms user CPU, 2 or 3 child processes. Output is **byte-identical to the installed chain** (`statusline-graft.sh`, which is `~/.claude/statusline.sh` plus graft's line), ANSI colour included, against a real payload: `showDirty` defaults to false because the shell script computes the `*N` count and then wipes it, and `modelStyle` defaults to `"id"` because it prints `claude-opus-5`. Both are config switches, so the richer forms are one edit away |
| dev-dashboard serve mode (**sibling, not #404**) | `scripts/benchmarks/dashboards/idle-cost.ts` | preview (rolldown watch build parked for life): RSS 1038 MB, 79 threads, 0.22% idle CPU, ready in 2.3 s | static (one build in a child, then serve): RSS 287 MB, 53 threads, 0.20% idle CPU, ready in 2.8 s |
| Swift waits and depth caps (**sibling #401**) | `scripts/benchmarks/swift/{ax-tool-depth,notify-rpc}.ts` | unbounded `findByIdentifier`, `raiseElementWindow`, `DispatchGroup.wait`, notify RPCs with no deadline | cap 50, 10 s and 30 s waits, 8 s RPC deadline exiting 75: lookups -9 to -18% at depth 10 to 40, rpc hello/status/list -17 to -22% |
| ai-usage-poll daemon | `~/.genesis-tools/logs/<day>.log` poll counts and `duration_ms` | 2026-09-15, clean pre-fix day: 890 polls, median 929 ms, p90 9448 ms, duty cycle 3.2% | 60 s floor per account and a 60 s tick. **Re-measured 2026-09-17 02:50; the section below has the three arms.** The tick was already 60 s in practice, so the poll count per hour did not move; the median rose to 3797 ms and the duty cycle to 8.8% because the tick now also refreshes the resident `usage sessions` answer, on purpose |
| `tools ai usage sessions` (Genesis.app, every 35 s) | `/usr/bin/time -p`, `bun --cpu-prof` | 1.6 s wall, 1.2 s user + 1.3 s sys per call; 0.6 s of it 364 codex `thread_items` scans (one per rollout) | codex projection index built once per home and cached by database stamp: 1.3 s wall, 0.95 s user + 1.2 s sys; the codex part is under 1 ms |
| `cr … --resume <text>` (content search) | `PROFILE=agent-sessions` probe | 12.0 s wall, 12.5 s CPU: every candidate transcript parsed and commit-regexed to place matches the picker never shows | `candidatesOnly` search: ripgrep gate plus metadata rows, 2.0 s wall, 0.86 s CPU |
| `tools ai` import tree (DECISION 2, lazy imports) | `tools ts imports lazy src/ai/index.ts`, `bun src/ai/index.ts --help` x10 | 298 ms sum of self, 465 modules; user CPU 0.36 s under load 26 to 37 (0.29 s quiet) | the ai barrel (122 ms) and run-who (57.5 ms) imported at their use sites with the measured saving in a comment: user CPU 0.22 s under the same load |
| `tools claude` import tree (D9 from the bash-calls-guard session) | `tools ts imports lazy src/claude/index.ts`, `bun src/claude/index.ts --help` x10 | 406 ms sum of self; user CPU 0.40 s, wall 0.30 s at load 10 to 14 | vite (53.9 ms) lazy inside the preview server, cli-highlight (49.8 ms) behind a `createRequire` in the sync `highlightCode`, clipboardy (32.8 ms) and `@inquirer/prompts` (12.1 ms) at their use sites: 278 ms sum of self, user CPU 0.27 s, wall 0.18 s at the same load. Every other tool that imports those four utils gets the same cut. Not done: `history.ts` → DashboardApp barrel (61.7 ms) because `defineDashboardApp` runs at registration and needs argv-gated registration to move |
| `tools ai usage sessions --hours 24 --min 10`, the window (DECISION 4) | `bun --cpu-prof`, `PROFILE=claude-history`, JSON row diff | every call refreshed metadata for all 12,322 Claude sessions and decoded every row, then kept 53 in JavaScript: catalog 282 ms, discover-full 220 ms, sampled CPU 2521 ms, direct call 0.93 s user | `mtimeFrom` + `newest` reach the refresh and the SQL (`idx_session_metadata_provider_mtime`): catalog 91 ms, discover-full 72 ms, metadata parse 42 ms to 6 ms, sampled CPU 1374 ms, direct call 0.74 s user; the 53 rows are byte-identical |
| `cr … --resume 7404` snippet | probe with the real Claude adapter | hydrated search 16.7 s for 11 hits; snippet = the first 1200 chars of the matched record (often a table, not the hit) | ripgrep gate + one ripgrep pass for the snippet: 0.96 to 1.17 s for 20 hits, snippet centred on the hit, a prose hit preferred over one inside a uuid; the ripgrep gate also counts hits inside ids, which the record-text match did not (11 to 20 candidates) |

## Follow-ups landed 2026-09-16 22:30

| Area | Script | Before | After |
|---|---|---|---|
| argv-gated registration for `tools ai` and `tools claude` | `scripts/benchmarks/startup/cli-startup.ts`, 7 runs, median CPU, load 9 to 22 | every subcommand registered all 28 (claude) or 7 (ai) trees before commander read argv: `claude who --help` 0.300 s, `claude history --help` 0.300 s, `ai sessions --help` 0.230 s, `ai usage --help` 0.230 s | one tree per recognised subcommand: 0.200, 0.190, 0.070, 0.190 s. `--help`, no arguments and an unknown subcommand still load everything by design (`claude --help` 0.310 to 0.330 s, `ai --help` 0.220 s unchanged), and their output is byte-identical. Also lazy, each with its measured comment: the ai-proxy ref scanner's config loader and `AiConfigStore` (66 ms and 52 ms, paid on every `tools ai` run just to REGISTER the scanner), `AIConfig` (51.6), the config TUI (59.8), darwinkit NLP (25.5) and classification (26.8), `ensurePackage` (25.6), `ModelManager` (24.6) |
| `tools ai usage sessions --json`, the resident answer | `scripts/benchmarks/startup/cli-startup.ts`, JSON row diff | every ask walked 3,796 directories and stat'd 12k files: 2.300 s CPU, 1104 ms wall | the `ai-usage-poll` tick writes `~/.genesis-tools/ai/usage-sessions.json` and `--json` reads it when it is under 90 s old and answers the same query: 0.220 s CPU, 204 ms wall, 54 rows byte-identical against `--fresh`. The entry carries the query, so `--hours 1` can never be served rows computed for `--hours 24`; the tick refreshes only while something has asked within the hour |
| the second discovery walk | four interleaved pairs of 5 runs on `usage sessions --fresh`, load 10 to 14 | `synchronizeHistory` re-walked every root for its write pass, milliseconds after the caller's walk: 1.600 s CPU, 800 ms wall | the caller passes the generation it discovered under; when `begin` claims exactly one more, no other writer intervened and the walk is reused: 1.410 s CPU, 700 ms wall. The profiler shows two `sync.discover-full` spans of 31 ms and 84 ms become `sync.discover-full-skipped` marks. A concurrent writer still forces the full walk (`sync-optimistic.test.ts`) |
| the listing metadata projection | direct reads against the real index, 12,344 rows, 5 reads, median | `SELECT m.*` carried `all_user_text`, up to 20 KB a session and 27 MB in total, into a list that shows a title and a path: 78 to 82 ms | `listMetadata({ withUserText: false })`, column list read from `PRAGMA table_info` so a new column is carried automatically: 65 to 66 ms. Only `search` matches on that column, and the default is unchanged |
| the getattrlistbulk walker | `scripts/benchmarks/startup/import-cost.ts` | every importer of `fs/disk-usage.ts` paid for `bun:ffi` and the binding, including the Claude discovery reader, which imports `bytesEqualStreaming` and never walks: 36.5 ms | bound through `createRequire` at the first walk, because `walkFiles` is a sync generator: 20.0 ms. The bulk path is still taken (26 of 26 entries carry an inline clone id) |
| `cr … --resume 7404`, the gate's incidental hits | probe against the real index | 20 candidates where 11 mention the ticket; the loudest false source was not a uuid but `<total_tokens>14997404 tokens left</total_tokens>`, the running token counter in every transcript, plus base64 blobs and a stackoverflow id | the needle inside a longer alphanumeric run is incidental; those sort last and the 11 prose matches come first. Nothing is dropped, because ripgrep reports a bounded number of windows per file (raised 3 to 8), so "no prose hit among them" is evidence and never proof |

## Verified, no change needed

Three items from the campaign's follow-up list turned out to be already correct. Each is recorded
here so the next reader does not re-open it.

- **dev-dashboard connected-client polling.** The 2.1% measured on the live server came from a
  FOCUSED tab. TanStack Query 5.102.8 gates an interval refetch on `focusManager.isFocused()`
  (`queryObserver.js:163`) unless `refetchIntervalInBackground` is set, and no query in this repo
  sets it, so an unfocused dashboard tab issues no requests at all. The 28 `refetchInterval` sites
  are work a watching user asked for.
- **Idle-skip for the SSE producers and pollers.** `live-events-source.ts` returns early on
  `sseBroadcaster.subscriberCount() === 0`, `dev-dashboard/lib/live/producers.ts` and
  `ai-usage-producer.ts` check `hub.subscriberCount(...)`, and `system/poller.ts` checks
  `lastClientSeenAt` against a 60 s threshold. `port/lib/scanner.ts` only runs while a user is
  watching, and the indexer's polling watch is the explicit fallback a user configures, whose
  incremental sync is its own change detection. The remaining waste is the 2 s wake itself, and
  only an IOKit sleep/wake observer would remove that.
- **macos-resources RSS.** 145 to 192 MB after the rewrite (memoised windows, headless core).
  Accepted in exchange for 10470 to 120 spawns a minute; not chased.

## What the remaining `usage sessions` time is

After the codex fix and the window (decision 4), the profile of one call is, in order: the
discovery walk over `~/.claude/projects` (3,796 directories, 12,493 files) and one `stat` per
file to learn which sessions moved (about 200 ms under load, 60 ms quiet), the `listSources`
read of the 12,322-row `file_index` (37 ms warm, up to 250 ms cold per process, run once per
provider plus once inside the write transaction), the transcript tails of the window's rows
(35 ms), and process start (220 ms for the lazy `tools ai` import tree plus 110 ms for the
launcher hop). The metadata refresh and the metadata read now cover the window only. What would
cut further: a resident answer (the poll daemon writing the rows to a file the app reads), and
dropping the second discovery walk when the first one is seconds old.

## Re-measured 2026-09-17 02:50 — the ai-usage-poll daemon

`cfc1dc0b7` (60 s per-account floor, 60 s tick) and `bb07e6fa9` (the tick refreshes the resident
`usage sessions` answer) both landed on 2026-09-16, two hours apart. That gives three arms in
`~/.genesis-tools/logs/`, read from the `[ai-usage] daemon poll starting` and
`daemon poll completed` lines. "Duty cycle" is the share of wall time spent inside a poll; it is
not CPU, because `duration_ms` is wall time.

| Arm | Window | Polls | Per hour | Median | p90 | Duty cycle |
|---|---|---|---|---|---|---|
| before both | 2026-09-15, full day | 890 | 37.1 | 929 ms | 9448 ms | 3.2% |
| 60 s floor only | 16th 17:57Z to 20:10Z | 133 | 60.3 | 810 ms | 6695 ms | 3.6% |
| both | 16th 20:10Z to 17th 00:50Z | 277 | 59.3 | 3797 ms | 9826 ms | 8.8% |

**The poll count per day is not a usable metric on this machine, and the old row's baseline was
wrong in two ways.** The gaps between polls on 2026-09-15 were already a median of 60.0 s
(495 of 889 gaps are exactly 60 s), so the tick was 60 s before the change as well; the day only
holds 890 polls because the laptop was asleep for 9.67 h across 33 gaps longer than two minutes.
Per hour of daemon uptime the rate is ~60/h in every arm. The old row also read 9.4 s as the
median when it is the p90 (the median was 929 ms), and "~12% of a core" does not reproduce: the
wall duty cycle was 3.2%.

Each poll is its own process (886 distinct pids for 890 polls), so a poll's cost is a process
start plus its work, and nothing accumulates between ticks.

**What did move is the per-poll duration, and that was the intent.** `session rows cache` with
`refreshed: true` appears 0 times on 2026-09-15 and on every poll afterwards, which is
`bb07e6fa9` keeping `~/.genesis-tools/ai/usage-sessions.json` warm. It costs the daemon a median
of about 3 s per tick and takes `tools ai usage sessions --json` from 2.300 s to 0.220 s of CPU
per call, measured in the row above. The 60 s floor on its own slightly lowered the median
(929 to 810 ms), which is what halving the live per-account fetches should look like.

⚠️ The "both" arm is 4.67 h of a quiet night, not a full day, and no log line counts per-account
upstream fetches, so the halving is inferred from the median and from the code, never measured
directly. Re-run the table after a full waking day for a like-for-like day arm:

⚠️ 2026-09-16 is not usable as a day arm for a second reason: its pre-fix hours ran a median of
3031 ms while 2026-09-15 ran 929 ms, with no code change between them. That day carried the
CPU-hog campaign's own load. The attribution above therefore rests on the two ADJACENT windows of
the same evening (810 ms, then 3797 ms) and on `session rows cache` appearing in the second and
not the first, never on a day-to-day median.

```bash
bun scripts/benchmarks/ai-usage/poll-duty.ts 2026-09-15 2026-09-18
```

## Rerunning

```bash
bun scripts/benchmarks/macos-resources/spawn-storm.ts --compare
bun scripts/benchmarks/fs/tools-watch.ts --compare
bun scripts/benchmarks/polls/agents-request-wait.ts --compare --runs 3
bun scripts/benchmarks/statusline/current-statusline.ts --compare --command "tools ai statusline run --claude"

# Startup and import cost (no baseline file: print, change, print again, note `uptime`)
bun scripts/benchmarks/startup/cli-startup.ts "claude who" 7 bun src/claude/index.ts who --help
bun scripts/benchmarks/startup/import-cost.ts "@genesiscz/utils/ai/AIConfig.ts"
```

Sibling PRs own youtube/dashboard/swift scripts; those commands are not in this tree.

Run one script at a time: two benchmarks in flight skew each other, and a load average above
about 30 on this machine turns every timing metric into noise (note `uptime` before each run).
