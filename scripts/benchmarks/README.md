# scripts/benchmarks

Measurement scripts. One directory per area being measured, plus
[`baselines/`](baselines/) holding the recorded "before" numbers.

The measurement primitives live in [`src/benchmark/lib/`](../../src/benchmark/lib/) and are
imported as `@app/benchmark/lib`. Read that module's
[README section](../../src/benchmark/README.md#in-process-measurement-library) before writing a
script: it says what the spawn and fs counters can and cannot see.

## Conventions

Every script in this tree follows the same shape, so a reviewer can read a number without
re-deriving how it was produced.

1. **One directory per area.** `scripts/benchmarks/<area>/<script>.ts`. A script measures one
   thing and says what that thing is in a header comment.
2. **`--baseline` records, `--compare` checks.** `--baseline [name]` writes the current numbers
   through `recordBaseline`. `--compare [name]` measures again and prints `formatComparison`,
   exiting non-zero when the comparison fails. With neither flag the script just measures and
   prints.
3. **Emit both shapes.** A human table through `out.println`, and the machine result through
   `out.result(json)` so a later script can diff it. Never put JSON through the table path.
4. **Note `uptime`.** Load average changes wall time on this machine by more than most fixes do.
   Record it beside the numbers; `recordBaseline` already stores `os.loadavg()`.
5. **Interleave the arms.** Run A, B, A, B, not all of A then all of B, or a load change during
   the run becomes "the fix".
6. **N >= 5 for any timing metric**, and report min/median/max rather than one number. A single
   sample cannot support a confidence claim at all. Counts (spawns, fs calls) are deterministic
   and N = 1 is enough for them.
7. **CPU time and counts are the primary metrics.** Wall time is the noisy one. See
   [`docs/benchmarks-cpu.md`](../../docs/benchmarks-cpu.md) for the measured evidence.

## Existing trees

- [`clones/`](clones/) — the `tools du` / APFS clone-detection microbenches and their runners.
  Predates these conventions and uses relative imports rather than `@app/benchmark/lib`.
