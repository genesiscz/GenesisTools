# Profiling Bun code

Contents: 1. `tools ts profile` · 2. reading the report · 3. traps · 4. other threads · 5. the repository profiler ·
6. raw `bun --cpu-prof`.

## 1. `tools ts profile` — start here

A pprof-style CPU profile of any entry point, with no timers added to the code
(`src/ts/commands/profile.ts`, `src/ts/lib/profile/`).

```bash
tools ts profile <entry.ts | tool name> -- <args for the entry>
tools ts profile ai -- usage sessions --json --fresh --no-cache-write
tools ts profile ./scratch.ts --runs 3 --top 30 --depth 6 --min-pct 2
tools ts profile ai --threads -- usage sessions --json --fresh
tools ts profile ai --focus listAgentSessionRows -- usage sessions --json --fresh
```

- `<entry>` is any `.ts` or `.js` file of any project, run in the current folder, or a GenesisTools tool name.
  `ai` above is not a keyword: it is the tool `tools ai` (`src/ai/index.ts`), so the second line profiles
  `tools ai usage sessions --json --fresh --no-cache-write`. Flags before `--` go to the profiler; everything
  after `--` goes to the entry.
- `--runs N` profiles N fresh processes and adds them up (per-run averages in the report). Use 3 or more.
- `--interval <µs>` sampling interval, default 250. Overhead: +3.0% at 1000 µs, +4.4% at 250 µs, +9.9% at 100 µs.
- `--top`, `--depth`, `--min-pct` shape the tables; `--focus <name>` shows the subtree under functions whose name
  contains it; `--json` prints the summary as data; `--bun <path>` picks another Bun binary.
- `--threads` also runs `/usr/bin/sample` on the process for its whole life (every thread, see section 4).
- The `.cpuprofile` files are kept under `~/.genesis-tools/ts/profiles/<stamp>/` and open in Chrome DevTools.

When the entry is a library function, write a three-line scratch script that imports and calls it, and profile
that. Keep scratch files under `/tmp/cc/<project>/<session>/` or move them there when done.

## 2. Reading the report

The header gives CPU of all threads (from `resourceUsage`), wall time, and the time sampled on the JS thread per
run, plus how much waiting was cut (section 3). Then three tables:

- **Hot functions (self time):** the leaf of each sample. `[native]` frames (`statSync`, `openSync`, `parse`,
  `toString`) are where JS called into Bun or JSC; this table tells you which primitive is hot.
- **Repository functions:** time with each repository function as the deepest repository frame, so a function's
  "own" time includes the library and native calls it makes, but not the repository functions it calls. This is
  the table that says which of OUR functions to change.
- **Repository call tree:** stacks reduced to repository frames, time below a frame including its callees.

Example that found a real win (2026-10-12, cold row build, 321 ms sampled): `readHeader` 77 ms of which
`openSync` 49.5 ms (308 Codex rollouts opened only to re-read unchanged headers), `historyCandidates` stat loop
53 ms. The first became a persisted identity cache (row build 1,180 → 423 ms).

## 3. Traps

- **The profile samples wall time on the JS thread, not CPU.** A native call that blocks (a `stat`, a file read)
  is counted for as long as it blocks. Measured: `statSync` showed 310 ms in a profile while the loop cost 25 ms
  of CPU. Confirm any I/O-heavy finding with a CPU A/B before acting on it.
- **`await` gaps.** Bun bills the gap between two samples to the frame that was on the stack, so a function that
  awaits 500 ms looked like 700 ms of work in Bun's own markdown report. `tools ts profile` counts a gap longer
  than 8 sampling intervals (and 8 ms) as one interval of work and reports the rest as "waiting, cut".
- **Other threads do not appear.** Bun's pool threads (async fs, file opens) and JSC's GC threads are invisible
  to `--cpu-prof`. When "CPU (all threads)" is far above the sampled JS time, use `--threads`.
- **`bun test` ignores every profiling flag.** Profile a scratch script that calls the code, or use a preload
  that starts a `node:inspector/promises` `Session` profiler and stops it in `afterAll`.
- **A default SIGINT, SIGTERM or SIGKILL exit writes NO profile** (Bun 1.4.2, 1.4.3). `process.exit(n)` and an uncaught
  throw do write it; a signal handler that calls `process.exit(0)` flushes it.
- **Child processes:** `BUN_OPTIONS="--cpu-prof --cpu-prof-dir=/abs/dir"` reaches every Bun child (each writes its own
  file). Workers need `worker.startCpuProfile()` (Bun 1.4). `BUN_CPU_PROFILE=1` from the Bun 1.4 blog is not honored.
- **Few samples are noise.** Shares under 10% from fewer than 300 samples; use `--runs 3` or more. `positionTicks`
  (line data) covers only 0.4% to 14% of samples, so trust functions, not lines.
- **Flags need the `=` form** (`--cpu-prof-dir=/x`, not `--cpu-prof-dir /x`) on Bun 1.3.13 and 1.4.2.

## 4. Every thread: `/usr/bin/sample`

```bash
/usr/bin/sample <pid> <seconds> 1 -mayDie -file /tmp/cc/<project>/<session>/sample.txt
```

`-mayDie` keeps going when the process exits; read the "Sort by top of stack" section for where the threads are
busy. Bun's own frames have no symbols (they show as `???` in the Bun binary); `tools ts profile --threads` groups
those per library. On 2026-10-12 this showed 44% of a fresh session list's busy samples in `__openat_nocancel` on
"Bun Pool" threads: async file opens, invisible to the JS profile.

## 5. The repository profiler (production phases)

`import { profiler } from "@genesiscz/utils/profile"`, one `const prof = profiler.scope("<scope>")` per module,
then `prof.measure`, `prof.measureAsync`, `prof.start`, `prof.mark`, `prof.summary`. Enable per run with
`PROFILE=<scope,scope>` or `PROFILE=*`; lines go to `~/.genesis-tools/logs/<date>-profiling.log`. A new scope name
goes into `PROFILER_SCOPE_NAMES` (`src/utils/profile/scopes.ts`). A disabled scope costs nothing.

The usage daemon logs every tick's phases with CPU (`[profile:ai-usage] tick.session-rows cpu=…ms … pid=…`). Join
those lines by pid with the day log's `"[ai-usage] session rows cache"` lines (`"via":"server"` or `"local"`) to get
real production distributions. On 2026-10-12: via the hub server median 26 ms (369 ticks), built locally median
1,940 ms (240 ticks), start plus setup median 542 ms per tick.

## 6. Raw `bun --cpu-prof`

```bash
bun --cpu-prof --cpu-prof-dir=/abs/dir --cpu-prof-name=run.cpuprofile --cpu-prof-interval=250 run entry.ts
bun --cpu-prof-md ...   # Bun's own markdown summary (await gaps billed as work, see section 3)
```

The file is Chrome's `.cpuprofile` JSON: `nodes` (with `callFrame` and `children`), `samples` (leaf node ids),
`timeDeltas` (µs since the previous sample). Weight samples by the gap to the NEXT sample, and clip long gaps.
Research notes: `<notes vault>/Dev/Bun/2026-10-12-BunCpuProfiling/`.
