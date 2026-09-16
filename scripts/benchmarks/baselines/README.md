# Benchmark baselines

One JSON file per named baseline, written by `recordBaseline` from
[`src/benchmark/lib/baseline.ts`](../../../src/benchmark/lib/baseline.ts) and read back by
`compareToBaseline`.

**These files are git-tracked on purpose.** A "before" number is only worth having if it outlives
the branch that produced it, so a fix committed in March can still be checked in September. Do not
gitignore this directory and do not delete a baseline because it looks stale: an old number is the
evidence that a regression happened, and re-recording it destroys that evidence.

## Shape

```json
{
    "name": "ai-usage-poll",
    "capturedAt": "2026-09-16T16:40:00.000Z",
    "commit": "5b4b8581f",
    "loadAvg": [3.21, 2.98, 2.71],
    "hostname": "example.local",
    "metrics": { "idleCpuPercent": 80.4, "spawns": 3, "fsCalls": 412 },
    "notes": "measured with the daemon otherwise idle"
}
```

`commit`, `loadAvg` and `hostname` are provenance. They are what lets a reader question a
suspiciously fast "after" run rather than believe it.

## Recording and comparing

```typescript
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";

await recordBaseline({ name: "ai-usage-poll", metrics, notes: "before the debounce fix" });

const cmp = await compareToBaseline({ name: "ai-usage-poll", metrics, tolerancePct: 10 });
out.println(formatComparison(cmp));
process.exitCode = cmp.ok ? 0 : 1;
```

## Tolerance convention

Every metric is **lower-is-better** by default, which is what these campaigns measure: CPU
milliseconds, spawn counts, fs call counts, stall milliseconds. A metric passes when

```
after <= before * (1 + tolerancePct / 100)
```

Name the exceptions in `lowerIsBetter` and everything outside that list flips to higher-is-better
(throughput, cache hit rate). Use **10 %** unless the metric argues otherwise; a count that should
not move at all takes `tolerancePct: 0`.

A comparison is `ok` only when the baseline exists, carries every metric just measured, and every
delta passes. A missing baseline is a failure, never a silent pass.

## Which metrics belong in a baseline

CPU time and call counts. Wall time on this machine swings with load average by more than most
fixes move it, so a wall-time baseline mostly records what else was running. The measured evidence
is in [`docs/benchmarks-cpu.md`](../../../docs/benchmarks-cpu.md). If a wall-time number has to go
in, record min/median/max across at least five interleaved runs, never a single sample.
