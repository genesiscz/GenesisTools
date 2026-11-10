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
