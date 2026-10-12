# Measuring: benchmarks and A/B

Contents: 1. what to measure · 2. the harness · 3. a benchmark pair · 4. A/B against an older commit ·
5. ordering · 6. controls · 7. reporting.

## 1. What to measure

- **CPU time** of the process: `process.cpuUsage()` deltas inside a child, or `proc.resourceUsage().cpuTime`
  (user + system, µs) of a spawned child. CPU barely moves with the load average; wall time moves a lot.
- **Cold and warm** in the same fresh process: the first pass is what a CLI call pays (JIT warm-up, empty
  in-memory caches), the second what a resident server pays. Report both.
- **Wall time** as context, especially for things a user waits on.
- **A check value** per arm (rows, lines parsed, files found, a byte total). Arms that do different work are not
  comparable; a check that disagrees is a bug in an arm, not a speed difference. Live data can move a check by a
  few lines between samples (transcripts grow); say so when it happens.
- **The input size** (files, lines, MB) and `uptime` before and after.

## 2. The harness

- `src/benchmark/lib`: `recordBaseline`, `readBaseline`, `compareToBaseline` (tolerance, `lowerIsBetter`, absolute
  `floor` per metric), `formatComparison`, `sampleProcess` / `sampleSelf`, `withSpawnCounter`, `withFsCounter`,
  `monitorLoopStalls`.
- `scripts/benchmarks/fs/shared.ts`: `parseBenchArgs` (`--baseline`, `--compare`, `--runs`, `--warmup`),
  `finishBench`, `median`, `summarize`.
- Baselines live in `scripts/benchmarks/baselines/<name>.json` and are committed.
- `docs/benchmarks-cpu.md` describes the CPU harness; `docs/benchmarks-du.md` has its own rules for `tools du`.

## 3. A benchmark pair (the pattern used everywhere on 2026-10-12)

- `<area>/<thing>-child.ts`: does ONE arm in a fresh process, a cold pass then a warm pass, prints one JSON line
  `{ coldCpuMs, warmCpuMs, check, ... }`.
- `<area>/<thing>.ts` (the parent): for each run, spawns the child once per arm (interleaved), collects metrics
  `<arm>.cold.cpuMs`, `<arm>.warm.cpuMs`, `<arm>.check`, and calls `finishBench`.
- Keep the arm list in a third file (`arms.ts`, `walk-trees.ts`). Importing it from the child file would RUN the
  child (top-level await code), which bit twice.
- Examples: `scripts/benchmarks/fs/walk-primitives.ts` + `walk-child.ts`, `fs/read-primitives.ts` +
  `read-child.ts`, `json/parse-arms.ts` + `parse-child.ts`, `agent-sessions/session-listing.ts`.

## 4. A/B against an older commit

When the "before" is code, not an arm, run both commits side by side:

```bash
git worktree add --detach /tmp/cc/<project>/<session>/worktrees/before <old-sha>
ln -s <main checkout>/node_modules /tmp/cc/<project>/<session>/worktrees/before/node_modules
```

Spawn the same command in both checkouts from one driver script, interleaved, and compare medians. When done,
check `git -C <path> status --short` and `git worktree remove <path>`. Note: `bun run` of a script inside a
worktree resolves `@app/*` and `@genesiscz/*` through that worktree's tsconfig, so each arm runs its own code.

## 5. Ordering

- **Interleave** (ABABAB...) so load spikes hit both arms.
- **Balanced orders** such as AABBAB or BAABBA when you worry about drift over the run.
- **Blocks** when the arms share state on disk (for example the same cache file with different versions): run
  BBBB AAAA BBBB AAAA and drop the first sample of each block, which is the one that rebuilds the shared state.
  Plain interleaving would make every sample cold for both arms.
- **Medians**, of at least 5 samples per arm, 7 to 9 for small differences. Print every sample too: a bimodal
  arm is a finding.

Example of why it matters: `statFiles` (bulk-read the folders of known paths) first looked slower, then the user
asked whether it was a flake. Retested with a fix (one reused buffer) in the order AABBCCCCBBAAABCCBA, 6 fresh
processes per arm: `statSync` 10.1 ms, bulk read for folders with 4 or more asked files 17.2 ms, for every folder
50.6 ms. Not a flake; the revert stood.

## 6. Controls

- **Negative control for a test:** run the new test against the old code (copy the file aside, `git show
  HEAD:<path> > <path>`, run, copy back) and confirm it FAILS. A test that passes on both proves nothing.
- **Positive control for an absence claim:** before "nothing found", show that the same command finds a known item.
- **Equivalence on real data:** before flipping a shared function (SafeJSON), compare old and new on real inputs
  (400 JSON files under `~/.genesis-tools` and `~/.claude`: equal values) and run the full suite
  (`bun run test`: 18,172 pass).

## 7. Reporting

State: the metric (CPU ms), the statistic (median of N), the order, the load average, the input size, the check,
both values, and the commit. Example: "cold row build 1,180 → 423 ms of CPU, median of 9 fresh processes per arm,
BAABBA blocks of 4, load 37, 630 rows in both arms, 747458e06 → 33778190a." Then the cause in one sentence.
