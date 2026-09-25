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
| ai-usage-poll daemon | `scripts/benchmarks/ai-usage/poll-duty.ts` over `~/.genesis-tools/logs/<day>.log` | 2026-09-15, clean pre-fix day: 890 polls over 14.87 h awake, 59.8 polls/h, median 929 ms, p90 9448 ms, duty cycle 5.1% | 60 s floor per account and a 60 s tick. **Re-measured 2026-09-17; the section below has the three arms.** The rate never moved: 59.8, 60.3 and 56.7 polls per awake hour across the three arms, because the tick was already 60 s. What moved is the median, 929 ms to 4093 ms, because the tick now also refreshes the resident `usage sessions` answer, on purpose |
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

| Arm | Window | Polls | Awake h | Per awake hour | Median | p90 | Duty cycle |
|---|---|---|---|---|---|---|---|
| before both | 2026-09-15, full day | 890 | 14.87 | 59.8 | 929 ms | 9448 ms | 5.1% |
| 60 s floor only | 16th 17:57Z to 20:10Z | 133 | 2.20 | 60.3 | 813 ms | 6695 ms | 3.6% |
| both | 16th 20:10Z onward | 700 | 12.35 | 56.7 | 4093 ms | 16225 ms | 9.9% |

**Rates are per hour the daemon was AWAKE, and that correction matters.** Dividing by the raw
span made 2026-09-15 read 37.1 polls/h for a tick that was demonstrably 60 s, which looks like a
rate change when the machine was simply off for 9.1 h. `poll-duty.ts` now subtracts the excess of
every sleep gap above one nominal tick before computing the rate and the duty cycle.

**The poll count per day is not a usable metric on this machine, and the old row's baseline was
wrong in two ways.** The gaps between polls on 2026-09-15 were already a median of 60.0 s
(495 of 889 gaps are exactly 60 s), so the tick was 60 s before the change as well; the day only
holds 890 polls because the laptop was asleep for 9.1 h across 33 gaps longer than two minutes.
Per awake hour the rate is 56.7 to 60.3 in every arm. The old row also read 9.4 s as the median
when it is the p90 (the median was 929 ms), and "~12% of a core" does not reproduce: the awake
duty cycle was 5.1%.

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
the same evening (813 ms, then 4093 ms) and on `session rows cache` appearing in the second and
not the first, never on a day-to-day median.

```bash
# The three arms above, in one command. --split is repeatable: N cuts give N+1 arms.
bun scripts/benchmarks/ai-usage/poll-duty.ts --from 2026-09-15 --to 2026-09-17 \
    --split 2026-09-16T17:56:48Z --split 2026-09-16T20:10:04Z

# One row per day instead, for a like-for-like day arm after a full waking day.
bun scripts/benchmarks/ai-usage/poll-duty.ts --from 2026-09-15 --to 2026-09-18
```

Positional dates name individual day files; `--from`/`--to` expand an inclusive range. The first
arm of the split form merges 2026-09-15 with the 16th before the fix, so read the per-day form
for the clean before-arm.

## 2026-09-24 18:32 — change-log sink cost in the PostToolUse hook

Measured what `recordFileToolChange` (Edit/Write) and `recordBashEdits` (Bash) add to
`src/agents/bin/hook-diff-post.ts`: sink off (no session id) against sink on (session id
present), plus a second Bash pair that isolates the sink alone from the capture/render pipeline
around it. Extends `scripts/benchmarks/hooks/hook-latency.ts`; the four original stages and
their budgets are untouched.

Command: `bun scripts/benchmarks/hooks/hook-latency.ts --runs 20 --json /tmp/hook-latency-changelog.json`

`uptime` right before the run: `18:32  up 12 days, 1:55, 24 users, load averages: 11.90 12.10
14.51`. This machine was carrying a load average around 11 to 14 during the whole run, well
above a quiet baseline, so the absolute ms figures below are noisy. The deltas are the
trustworthy signal, because every pair was measured interleaved (A, B, A, B, ...).

Stages, median over 20 interleaved pairs with 3 warmup pairs discarded, wall time in ms
(`/usr/bin/time -l` user/sys CPU alongside; its resolution is 10 ms, so treat those as
approximate, not precise):

- Edit, sink off (no session id): min 20.5, median 21.5, max 23.6; cpu user 10.0 / sys 0.0
- Edit, sink on (session id present): min 32.1, median 33.0, max 35.1; cpu user 10.0 / sys 10.0
- Bash `sed -i`, session absent (this also disables the whole capture/diff pipeline, not only
  the sink): min 21.6, median 22.6, max 25.4; cpu user 10.0 / sys 0.0
- Bash `sed -i`, session present (pipeline and sink both on): min 35.7, median 37.7, max 46.1;
  cpu user 10.0 / sys 10.0
- Bash, render only (`cat` on the watched file, `commandEditsFiles` false so the sink is
  skipped, session present): min 28.2, median 30.6, max 61.5; cpu user 10.0 / sys 10.0
- Bash, render plus sink (`sed -i` on the watched file, `commandEditsFiles` true, session
  present): min 36.9, median 38.5, max 75.7; cpu user 20.0 / sys 10.0
- Cold, fresh `GENESIS_TOOLS_HOME`, single sample, Edit sink on: 46.8 (first-ever call, pays
  `git init --bare`)
- Cold, fresh `GENESIS_TOOLS_HOME`, single sample, Bash render plus sink: 48.7 (same)

Deltas:

- Edit, sink on minus sink off: **11.5 ms**. Clean isolation: nothing else on the Edit/Write
  path reads the session id, so this delta IS the sink's added cost.
- Bash, session present minus absent: **15.1 ms**, but NOT a clean isolation. `runDiffPost`
  itself needs a session id to build its capture directory (the `safeSegment(payload.sessionId)`
  guard before `callDir` in `src/agents/lib/hooks/diff/run.ts`), so an absent session id skips the whole
  capture/diff pipeline, not only the sink. This number answers "what does having no session id
  save for Bash", not "what does the sink alone cost."
- Bash, render plus sink minus render only: **7.9 ms**. This is the clean isolation for Bash:
  both sides keep the session id and run the identical capture/render pipeline over the same
  watched file (`cat` vs `sed -i` only changes whether `commandEditsFiles` reads true); the only
  code that branches on that is `recordBashEdits` itself, so this delta IS the sink.

Honest read: 8 to 12 ms per call is "a few ms," not a spike, and it fits inside the existing
30 ms "post phase, no change" budget's headroom. It is not free either, and it does not come
from a fixed constant: it scales with how many `git hash-object` spawns the call needs.

Cost driver, steady state (this is NOT the one-time `git init --bare`, see below):
- Edit/Write (`recordFileToolChange` -> `recordChange`, `src/agents/lib/changes/log.ts`) hashes
  `before` and `after` as two SEPARATE `sink.hash()` calls: two unbatched `git hash-object -w
  --stdin` process spawns per call. That lines up with its delta (11.5 ms) running roughly 1.4x
  the Bash arm's single-spawn delta.
- Bash (`recordBashEdits` -> `recordScriptedEdits` -> `prehashed`) batches every blob of one
  call through ONE `git hash-object -w --stdin-paths` (`hashAll`), so a call touching 1 file
  pays for exactly one spawn, not two.

Cold start: the very first call against a fresh `GENESIS_TOOLS_HOME` additionally pays
`ensureRepo`'s `git init --bare` (`src/agents/lib/changes/objects.ts:16-28`) on top of the
steady-state cost above. Single-sample observations, not a confidence claim: Edit sink-on cold
was 46.8 ms against a 33.0 ms warm median (about +14 ms for the one-time init); Bash render plus
sink cold was 48.7 ms against a 38.5 ms warm median (about +10 ms). The interleaved measurements
above are already warm by construction: each arm reuses one `GENESIS_TOOLS_HOME` across all 23
calls per pair (3 discarded warmups plus 20 measured), so `git init --bare` runs once during a
discarded warmup and never lands in the reported min/median/max.

Controls, all 6 held:
- Positive (session present): Edit sink on, Bash session-present, and Bash render-plus-sink each
  left 23 rows (one per call, warmups included) in their session's `changes.jsonl`.
- Negative (session absent, or `commandEditsFiles` false): Edit sink off, Bash session-absent,
  and Bash render-only each left no session directory at all under their `GENESIS_TOOLS_HOME`.

One existing, unrelated stage ran over its own budget during this run: "pre phase: guard plus
capture" at 114.7 ms against its 110 ms budget. That stage and its budget are untouched by this
work; the machine's load average (11 to 14) is the more likely explanation than a regression.

## 2026-09-24 18:57 — Edit/Write hashing batched: sink cost 11.5 ms to 7.1 ms

`recordFileToolEdit` now hands `before` and `after` to `prehashed()`, so an Edit or Write stores
both blobs through ONE `git hash-object -w --stdin-paths` instead of two `--stdin` spawns (the
driver named in the section above). The same run also carries the new `toolUseId` field on every
row. Same command, same harness, 20 interleaved pairs, 3 warmups discarded.

`uptime`: `18:57 up 12 days, 2:19, 25 users, load averages: 11.33 15.22 14.78` (still loaded).

- Edit, sink off: min 23.3, median 24.8, max 30.5
- Edit, sink on: min 29.7, median 31.8, max 87.4
- Edit delta, sink on minus off: **7.1 ms** (was 11.5 ms). It now matches the Bash arm.
- Bash, render plus sink minus render only: **7.7 ms** (was 7.9 ms; unchanged code, within noise).
- Cold first call, fresh home: Edit 44.1, Bash 51.9 (single samples, `git init --bare` once).
- All six positive and negative controls held again (23 rows on, no session directory off).

Read: one `git` spawn per call is now the whole steady-state cost on both paths, about 7 ms.

## Rerunning

```bash
bun scripts/benchmarks/macos-resources/spawn-storm.ts --compare
bun scripts/benchmarks/fs/tools-watch.ts --compare
bun scripts/benchmarks/polls/agents-request-wait.ts --compare --runs 3
bun scripts/benchmarks/statusline/current-statusline.ts --compare --command "tools ai statusline run --claude"
bun scripts/benchmarks/hooks/hook-latency.ts --runs 20 --json /tmp/hook-latency.json

# Startup and import cost (no baseline file: print, change, print again, note `uptime`)
bun scripts/benchmarks/startup/cli-startup.ts "claude who" 7 bun src/claude/index.ts who --help
bun scripts/benchmarks/startup/import-cost.ts "@genesiscz/utils/ai/AIConfig.ts"
```

Sibling PRs own youtube/dashboard/swift scripts; those commands are not in this tree.

Run one script at a time: two benchmarks in flight skew each other, and a load average above
about 30 on this machine turns every timing metric into noise (note `uptime` before each run).
