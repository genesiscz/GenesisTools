# CPU-hog benchmarks

State as of 2026-09-16 20:30. Every number below is a median over interleaved runs on this Mac,
recorded with the in-process harness in `src/benchmark/lib` (`sampleProcess`, `sampleSelf`,
`withSpawnCounter`, `withFsCounter`, `monitorLoopStalls`, `recordBaseline`, `compareToBaseline`
with an absolute `floor` per metric). Baselines are git-tracked JSON under
`scripts/benchmarks/baselines/<name>.json`; every script takes `--baseline` to record and
`--compare` to gate. CPU time and counts are the metrics; wall time on this machine swings with
the load average and is reported, never gated. The rule that came out of this work is the
"Never spin" section of `CLAUDE.md`; the detection side is `bun scripts/ci/lint-rules.ts`
(timers under 100 ms, `sleepSync` in a loop, a Swift `.wait()` without a timeout) and
`tools doctor cpu` (two `ps -o cputime` samples, what burned a core in between).

## The incident that started it

A GenesisTools.app `--rpc` face whose `RunLoop.run(mode:before:)` had no input sources returned
at once, spun at 60% of a core for 1 h 03 m, and held the Launch Services registration, so every
notification click went to it and was swallowed. The reap in `bun run app` catches that shape
now; the Swift fixes below make the waits finite.

## Results per area

| Area | Script | Before | After |
|---|---|---|---|
| Youtube pipeline workers | `scripts/benchmarks/youtube/pipeline-idle.ts` | 48 workers polling SQLite every 250 ms: 182 idle claims/s, 0.50% CPU idle | one on-demand `WorkerPool`: 0 idle claims, 1 statement/s, 0.18% CPU; burst first start 18 ms to 0.3 ms, drain 24.7 ms to 6.2 ms |
| macos-resources TUI | `scripts/benchmarks/macos-resources/spawn-storm.ts` | one `ps` and `lsof` fork per process per tick: 10470 spawns/min, 4.50% CPU | one batched `ps` + `lsof` per refresh, windowed table: 120 spawns/min, 2.50% CPU, RSS 145 to 192 MB (accepted) |
| `tools watch --follow` | `scripts/benchmarks/fs/tools-watch.ts` | 50 ms stat loop, chokidar polling, watchers rebuilt per rescan: 1.6% idle CPU | native events, watchers added once, size sweep per `--seconds`: 0.8% idle CPU, new-file latency -37% |
| sub-100 ms polls and sync waits | `scripts/benchmarks/polls/*.ts` | agents request wait 44 reads/s at 10.5% CPU; codex control loop 48 exists checks/s; `waitFor` stall 1055 ms; teams launch stall 4144 ms; agents-bridge register 17 spawns | 1.3 reads/s at 0.9% CPU; 0 exists checks/s (wake on the file); stall 39 ms; stall 3 ms; 1 spawn |
| Claude Code statusline | `scripts/benchmarks/statusline/current-statusline.ts` | shell script, ~75 processes per render: 826/743/883/823 ms median across four repos, ~660 ms user CPU | `tools ai statusline` in-process: 109/87/86/84 ms, ~103 ms user CPU, 2 or 3 child processes |
| dev-dashboard serve mode | `scripts/benchmarks/dashboards/idle-cost.ts` | preview (rolldown watch build parked for life): RSS 1038 MB, 79 threads, 0.22% idle CPU, ready in 2.3 s | static (one build in a child, then serve): RSS 287 MB, 53 threads, 0.20% idle CPU, ready in 2.8 s |
| Swift waits and depth caps | `scripts/benchmarks/swift/{ax-tool-depth,notify-rpc}.ts` | unbounded `findByIdentifier`, `raiseElementWindow`, `DispatchGroup.wait`, notify RPCs with no deadline | cap 50, 10 s and 30 s waits, 8 s RPC deadline exiting 75: lookups -9 to -18% at depth 10 to 40, rpc hello/status/list -17 to -22% |
| ai-usage-poll daemon | `~/.genesis-tools/logs/<day>.log` run counts | 12 accounts fetched on almost every 30 s tick: ~890 runs/day at a 9.4 s median, ~12% of a core | 60 s floor per account and a 60 s tick; re-measure after a day |
| `tools ai usage sessions` (Genesis.app, every 35 s) | `/usr/bin/time -p`, `bun --cpu-prof` | 1.6 s wall, 1.2 s user + 1.3 s sys per call; 0.6 s of it 364 codex `thread_items` scans (one per rollout) | codex projection index built once per home and cached by database stamp: 1.3 s wall, 0.95 s user + 1.2 s sys; the codex part is under 1 ms |
| `cr … --resume <text>` (content search) | `PROFILE=agent-sessions` probe | 12.0 s wall, 12.5 s CPU: every candidate transcript parsed and commit-regexed to place matches the picker never shows | `candidatesOnly` search: ripgrep gate plus metadata rows, 2.0 s wall, 0.86 s CPU |
| `tools ai` import tree (DECISION 2, lazy imports) | `tools ts imports lazy src/ai/index.ts`, `bun src/ai/index.ts --help` x10 | 298 ms sum of self, 465 modules; user CPU 0.36 s under load 26 to 37 (0.29 s quiet) | the ai barrel (122 ms) and run-who (57.5 ms) imported at their use sites with the measured saving in a comment: user CPU 0.22 s under the same load |
| `tools claude` import tree (D9 from the bash-calls-guard session) | `tools ts imports lazy src/claude/index.ts`, `bun src/claude/index.ts --help` x10 | 406 ms sum of self; user CPU 0.40 s, wall 0.30 s at load 10 to 14 | vite (53.9 ms) lazy inside the preview server, cli-highlight (49.8 ms) behind a `createRequire` in the sync `highlightCode`, clipboardy (32.8 ms) and `@inquirer/prompts` (12.1 ms) at their use sites: 278 ms sum of self, user CPU 0.27 s, wall 0.18 s at the same load. Every other tool that imports those four utils gets the same cut. Not done: `history.ts` → DashboardApp barrel (61.7 ms) because `defineDashboardApp` runs at registration and needs argv-gated registration to move |
| `tools ai usage sessions --hours 24 --min 10`, the window (DECISION 4) | `bun --cpu-prof`, `PROFILE=claude-history`, JSON row diff | every call refreshed metadata for all 12,322 Claude sessions and decoded every row, then kept 53 in JavaScript: catalog 282 ms, discover-full 220 ms, sampled CPU 2521 ms, direct call 0.93 s user | `mtimeFrom` + `newest` reach the refresh and the SQL (`idx_session_metadata_provider_mtime`): catalog 91 ms, discover-full 72 ms, metadata parse 42 ms to 6 ms, sampled CPU 1374 ms, direct call 0.74 s user; the 53 rows are byte-identical |
| `cr … --resume 7404` snippet | probe with the real Claude adapter | hydrated search 16.7 s for 11 hits; snippet = the first 1200 chars of the matched record (often a table, not the hit) | ripgrep gate + one ripgrep pass for the snippet: 0.96 to 1.17 s for 20 hits, snippet centred on the hit, a prose hit preferred over one inside a uuid; the ripgrep gate also counts hits inside ids, which the record-text match did not (11 to 20 candidates) |

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

## Rerunning

```bash
bun scripts/benchmarks/youtube/pipeline-idle.ts --compare
bun scripts/benchmarks/macos-resources/spawn-storm.ts --compare
bun scripts/benchmarks/fs/tools-watch.ts --compare
bun scripts/benchmarks/polls/agents-request-wait.ts --compare --runs 3
bun scripts/benchmarks/statusline/current-statusline.ts --compare --command "tools ai statusline run --claude"
bun scripts/benchmarks/dashboards/idle-cost.ts --mode preview,static --repeat 5 --compare
bun scripts/benchmarks/swift/ax-tool-depth.ts --compare
```

Run one script at a time: two benchmarks in flight skew each other, and a load average above
about 30 on this machine turns every timing metric into noise (note `uptime` before each run).
