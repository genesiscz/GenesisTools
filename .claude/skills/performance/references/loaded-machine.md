# A loaded Mac: process-table reads, hooks, and what a load of 500 is made of

Findings of one session on 2026-11-10 (16 cores, 128 GB RAM, about 35 Claude sessions, load average 300 to 800 for
hours). Each number names its source. Where a line says "one observation", it is not a result.

## Load 500 was not CPU work

- At load 690 to 787, 312 processes were runnable. 176 of them were children of two iOS simulators' `launchd_sim`,
  both booted 30 minutes earlier and still starting services. The top-CPU list summed to about 5 of 16 cores.
- So group **runnable processes by owner** (simulator device, agent session, app). A top-CPU list does not explain a
  high load. The diagnostics skill has this view: GenesisClaude `user/skills/diagnostics/scripts/choke.ts`.
- The hooks and mods were not the cause. At the peak hour (2,710 Bash calls) the Bash hooks used about 0.3 of one
  core (vault report `GenesisBrain/GenesisTools/2026-11-10-ModsPerformance.md`).

## Reading the process table can hang for the whole machine

- `ps -Ao pid=` took 18.85 s, 7.27 s and 4.77 s within one minute at load 430 to 600, with about 2,100 processes.
  Seconds before and after, the same read took 0.05 to 0.2 s. `timeout` could not end it sooner: it waits in the
  kernel.
- Every reader waits together. Two `tools hub widget call` processes died at their 120 s limit, and a decision the
  user picked in the widget was lost. `~/.genesis-tools/logs/app-perf.log` had 683 lines
  "ps ... did not exit within 3 s" that morning, in bursts with quiet gaps while the load stayed high.
- What was measured about the cause:
  - One `lsof -nP -Fi` pass beside `ps` did not slow it (0.08 to 0.20 s against 0.07 to 0.12 s alone, 4 runs each).
  - High load alone did not produce it: reads were fast at load 330 to 640 between the bursts.
  - All five slow reads of one 7-minute watch fell inside one run of a daemon task that walks the disk and runs two
    whole-table `lsof` passes (`disk-build-purge`, 5 to 10 minutes a run that morning, 35 to 54 s on a calm day).
    With the task off, the next 14 minutes had no slow read. One on/off pair: an observation.
  - Not found: what holds the kernel's process list in those seconds. That needs a kernel sample (`spindump`,
    root).
- The hub was a frequent reader: `ps -axo` with eight columns 133 to 466 times an hour, with overlapping reads, 244
  killed at their timeout in six hours. Commit 9b75648a3f makes the hub's refreshes share one read.

### Rules that follow

- **Never spawn `ps`, `lsof` or `pgrep` on a timer or per event.** TypeScript: `no-process-tool-spawn`
  (`scripts/ci/lint-rules.ts`); read through `@genesiscz/utils/process`. Swift: `swift-no-process-tool-spawn`
  (`scripts/ci/swift-lint-rules.ts`, added 2026-11-10; two old call sites are listed with what bounds them).
- **A reader that timed out must not retry at once.** A retry is one more reader of a table that is already slow.
  Keep the slow answer for a multiple of the time it took (9b75648a3f: ten times, at most 60 s).
- **Share one read across callers in a process**, and across processes when one already has it (the hub server).
- **Give every process-table read a timeout and a visible failure.** A probe that hangs with the table is useless
  in the one moment it is needed. `choke.ts` prints "process table read timed out after N s" and still reports
  memory.
- **A periodic task needs a load guard**, not only a timeout. A task that takes 50 s on a calm machine took 10
  minutes at load 500 and hit its timeout in 3 of 7 runs, while it added readers and I/O. Skip the run above a
  load limit (`os.loadavg()[0]`) and say so in the log.
- To catch a hang with evidence: GenesisClaude `user/skills/diagnostics/scripts/ps-hang-watch.ts` times three reads
  every few seconds and records process states, new processes, readers and running tasks when one is slow.

## The hub's `ps` was never a fallback, and what replaced it (2026-11-10, second session)

- The eight-column `ps -axo pid=,ppid=,user=,state=,pcpu=,rss=,lstart=,command=` is `listPsTable`
  (`src/utils/process/ps.ts`). The hub's process report called it on purpose (`src/hub/lib/procs/sources.ts`). The
  libproc self-check passes on this Mac: `listProcessTable()` gave 2,113 rows in 5.2 ms. The fallback in
  `processes.ts` asks for other columns (`pgid=,uid=,tty=`) and did not run.
- So before you look for a failed self-check, compare the column list of the `ps` you see with the two specs.
- The report now reads the kernel (`kernelProcsTable`, 6188da45cd). 9 fresh processes for each arm, interleaved, load
  76 to 87, Bun 1.4.2, 2,103 rows, CPU net of the 228 ms that the imports cost: `ps` 123 ms, kernel 58 ms. Wall time
  of the read: 151 ms against 48 ms. One read against one `ps`: 2,093 of 2,093 start times equal, 1,795 of 1,796
  command lines of this user equal.
- A caller that compares a row with `ps -p` later needs the start time in whole seconds. The kernel gives
  microseconds, and `stopTree` refuses a process whose start differs.
- Another user's process has no CPU, no memory and no arguments in a kernel read. A view that must show them still
  needs the setuid `ps` (the app's load-top probe).
- The kernel read is synchronous. It runs on the hub server's event loop, as the read of the session list already
  did. If a read of the kernel's process list can hang, it now blocks that loop. See the next section for what is
  known.

## A slow first `ps`, and a hub server that was silent for 222 s

- In the hang watch journal (`~/.genesis-tools/diagnostics/ps-hang.jsonl`) every slow read was the first of three:
  `ps -Ao pid=` took 18.85 s, 4.77 s and 7.27 s, and the `ps -Ao pid=,args=` that started right after it took 0.11
  to 0.17 s. Swap held 10.1 of 11.3 GB and the interval had 788,442 page-ins. So a start of `ps` that pages its
  binary in fits the data as well as a locked process list does. Nobody sampled it; both stay open.
- The hub server (one process) logged nothing from 05:26:49 to 05:30:31 local time. Its timers did not run: a
  process report that ended at 05:31:16 says `elapsedMs: 261016`, with a 10 s limit on its `ps`. What blocked the
  loop is not known (no sample). A `sample <pid> 2` of `gt-hub` during such a silence would name it.
- During that silence the widget's write of a pick waited 120 s at the server and failed. See the widget section.
- A call that waits at a blocked server costs its whole limit. Then the app runs the same call as a process, and
  that often answers in 1 to 2 s (6 `question inbox` calls: 62.2 to 63.6 s in total). The app has no test for "the
  server does not answer at all". `{"op":"health"}` exists in the server and no client sends it while a call waits.
  This is the largest open item.

## User actions on a slow Mac: keep the input

- A widget pick is written with `tools hub widget call` (action `ledger`). On 2026-11-10 that call got no answer
  for 120 s. The pick stopped showing after 60 s (`pendingStageUnansweredLifetime`), and at 120 s the failure
  handler removed it and its note. The send that waited behind it took 120 s more: "Sending…" for 4 minutes.
- Now (68f926c887): the write ends at 30 s. No answer is not a refusal: the pick and its note stay shown, with the
  note "The hub did not answer within 30 seconds, so this pick is not saved yet. It stays here." and Try again. A
  pick whose write still runs does not expire.
- Rule: a timeout handler must not run the same code as a refusal handler when that code drops the user's input.
- Rule: a timeout shorter than the old one needs the count of calls it now cuts. Of 624 widget calls in five days,
  6 that answered took longer than 30 s.

## Call wrappers of the app (Swift)

- `ToolsBridge.run` shares one limit between the server's try and the process. After a server timeout the process
  had 0 s left, was started and was killed at once: 41 starts in five days. It is not started now (82e22216a8).
- `ToolsCLIRunner.capture` gives the process a new full limit after a server timeout (worst case 2T + 1 s). It is
  not changed: the process answered in 1 to 2 s in the measured cases, because the server was blocked and the Mac
  was not.
- The load-top probe of `HangWatch` waits 10 minutes after a `ps` that failed (20481c31a6). It failed 59 times of
  414 in five days, 41 of them in two hours of 2026-11-10.
- `FseventsdHealth.read()` in `DiskSystemProbes.swift` has no caller in the app.
- The stuck poll had no guard: SwiftUI's `.task(id:)` starts a new watch on each change of the watched sessions, and
  the detached check of the old watch runs on. One check runs at a time now (570dcdae21). A `Task.detached` inside a
  cancelled task is not cancelled: give such a store its own in-flight flag.
- Two `git` helpers of the hub (`HubWorktrees.git`, `HubCommitLink.git`) had no limit. They end at 10 s now and
  answer nil, as a failed `git` does (b6835b4b39).
- The Swift build trees were gone that morning (a purge task removed them). A cold `swift test` of GenesisKit took
  about 2 minutes at a load of 60, a cold `bun run app:test` about 5 minutes. Both are possible under load; the
  install (`bun run app`) restarts the app's faces and is a separate decision.

## Measured and rejected

- One shared, paced read of the tmux and cmux locations for the session list (3 s reuse). A replay of the day's
  1,041 reads: only 226 were in resident hub servers, and the reuse cut those to 214. The other 815 came from 717
  short `tools` runs, which share nothing. Not shipped: 3 s of staleness for 5% fewer reads.

## Hooks: one process per item is the cost

Measured with 15 interleaved runs, CPU p50, load 450 to 590 (same vault report):

| Change | Before | After |
|---|---|---|
| One `git ls-files` for all untracked directories of a checkout, not one per directory (47 directories) | 809 ms, 49 `git` | 442 ms, 3 `git` (3d403d33fc) |
| No profiler import to time a 0.5 ms payload parse | 72 ms hook start | 45 ms (20a5ba8f4c) |

- The largest hook cost left is two `git status` per Bash call (111 to 163 ms each). It is not fixed.
- A lazy import that was expected to help gave nothing (74.2 ms against 74.4 ms) and was dropped: measure the
  import before moving it.
- `~/.genesis-tools/agents/hooks-dist` is a symlink to the main checkout, so a hook fix is live in every session at
  once. A mod loads at session start, so a mod fix reaches only new sessions.

## Traps met while measuring under load

- A single run proves nothing here. A test that spawns the CLI fails at bun's 5 s limit under load and passes with
  `--timeout 120000`; call it broken only after that.
- `expect(promise).rejects` on a promise that never settles makes Bun spin at 100% CPU. Two such test processes ran
  for 2 and 7 minutes.
- macOS `cmp -n <bytes>` exits 1 with "EOF" when one file is shorter. Compare a byte range with a hash.
- `ditto --hfsCompression` on the same volume makes an APFS clone and compresses nothing (`--noclone` compresses),
  and it stores a file above 512 MiB plain without an error. More on transparent compression:
  `references/compression.md` and the handoff `cold-compress-into-tools-du`.
- The daemon runs a newly registered task at once, not at its first scheduled time.
